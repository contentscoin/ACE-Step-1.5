"""The Celery application, as a shell over :mod:`musicstudio_dsp.pipeline`.

Design §2.3 and §11.3 put the DSP work in a Celery worker behind a broker. This
module is the whole of that arrangement, and it is deliberately thin: each task
decodes its transport encoding, calls one function from
:mod:`musicstudio_dsp.pipeline`, and encodes the result. No DSP logic lives here.

### Why the shell is this thin

**No broker is reachable from a test environment**, and none should be needed.
A task body containing real behaviour can only be tested by either standing up
Redis or by calling ``.apply()`` and pretending. Both are worse than the
alternative, which is that the behaviour lives in plain functions that the tests
call directly and the tasks contain nothing worth testing. What *is* tested here
is the shell's own contract: that each task is registered, that its transport
encoding round-trips, and that ``.run()`` reaches the pipeline. None of that
touches a connection.

Consequently ``celery_app`` is built but never connected at import time —
constructing a ``Celery`` object performs no I/O, and the broker URL is read from
the environment so an unset variable yields an app that simply has nowhere to
send work rather than one that fails to import.

### Transport encoding

Audio is bytes and the serializer is JSON, so the task boundary carries
base64 text. That is a stopgap and is marked as one: a production topology sends
an object locator and lets the worker read storage, which is the ``{kind:
'stored', objectKey}`` arm of ``MeasurementSubject`` in
``services/sound/measurement.ts``. There is no object store in the product layer
yet, so there is nothing to name; when one arrives, the change is confined to
these shells because the pipeline functions already take bytes.

Pickle is *not* enabled to avoid the base64 overhead. A broker that accepts
pickled payloads executes whatever it is sent, and the worker sits behind a
public API surface (Requirement 17).
"""

from __future__ import annotations

import base64
import os
from typing import Any, Final

from celery import Celery

from .effects import apply_chain, parse_chain
from .formats import AudioFormat, decode, encode
from .loudness import measure
from .mastering import clean_dialogue, duck, normalise_loudness
from .mfcc import CUE_PAIR_SIMILARITY_CEILING, mfcc_vector, similarity_report
from .mixdown import RenderParams, TrackRender, render_mixdown
from .mixdown_clip import ClipRender
from .waveform import reduce_to_waveform
from .pipeline import (
    STORAGE_FORMAT,
    convert_for_download,
    normalise_for_storage,
)
from .sound_pack import (
    CueSource,
    export_pack,
    max_short_term_loudness_lufs,
)

__all__ = [
    "DEFAULT_BROKER_URL",
    "DEFAULT_RESULT_BACKEND",
    "apply_effect_chain_task",
    "celery_app",
    "clean_dialogue_task",
    "convert_for_download_task",
    "cue_pack_similarity_task",
    "duck_task",
    "export_sound_pack_task",
    "render_mixdown_task",
    "waveform_task",
    "measure_loudness_task",
    "normalise_for_storage_task",
    "normalise_loudness_task",
]

#: Overridden per environment. Design §11.3's topology supplies the real one.
DEFAULT_BROKER_URL: Final[str] = "redis://localhost:6379/0"
DEFAULT_RESULT_BACKEND: Final[str] = "redis://localhost:6379/1"

celery_app = Celery(
    "musicstudio_dsp",
    broker=os.environ.get("MUSICSTUDIO_DSP_BROKER_URL", DEFAULT_BROKER_URL),
    backend=os.environ.get("MUSICSTUDIO_DSP_RESULT_BACKEND", DEFAULT_RESULT_BACKEND),
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # One task per process at a time. Part of design §5.5's determinism rule;
    # the other part, a single BLAS thread, cannot be set from here — the
    # thread-pool size is fixed when NumPy loads its backend, which has already
    # happened by the time this module is imported. It belongs in the worker
    # container's environment (`OMP_NUM_THREADS=1` and the vendor-specific
    # equivalents), and design §11.3's topology is where that is declared.
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    timezone="UTC",
    enable_utc=True,
)


@celery_app.task(name="musicstudio_dsp.normalise_for_storage")
def normalise_for_storage_task(
    audio_base64: str, audio_format: AudioFormat = STORAGE_FORMAT
) -> dict[str, Any]:
    """Requirements 19.4, 19.5. Shell over :func:`pipeline.normalise_for_storage`."""
    result = normalise_for_storage(base64.b64decode(audio_base64), audio_format)
    return {
        "audio_base64": base64.b64encode(result.data).decode("ascii"),
        "audio_format": result.audio_format,
        "duration_ms": result.shape.duration_ms,
        "sample_rate": result.shape.sample_rate,
        "channels": result.shape.channels,
        "original_sample_rate": result.original_sample_rate,
        "original_duration_ms": result.original_duration_ms,
        "length_error_ms": result.length_error_ms,
        "resampled": result.resampled,
    }


@celery_app.task(name="musicstudio_dsp.convert_for_download")
def convert_for_download_task(
    audio_base64: str, audio_format: AudioFormat
) -> dict[str, Any]:
    """Requirements 13.3, 13.9, 13.10. Shell over :func:`pipeline.convert_for_download`."""
    result = convert_for_download(base64.b64decode(audio_base64), audio_format)
    return {
        "audio_base64": base64.b64encode(result.data).decode("ascii"),
        "audio_format": result.audio_format,
        "sample_rate": result.sample_rate,
        "channels": result.audio.channel_count,
        "duration_ms": result.audio.duration_ms,
        "lossless": result.lossless,
        "length_error_ms": result.resample.length_error_ms,
    }



@celery_app.task(name="musicstudio_dsp.apply_effect_chain")
def apply_effect_chain_task(
    audio_base64: str, chain_document: str, audio_format: AudioFormat = STORAGE_FORMAT
) -> dict[str, Any]:
    """Requirements 29.12, 29.29–29.32. Shell over :func:`effects.apply_chain`.

    The chain arrives as a JSON *string* rather than as a decoded list, so that the
    task's transport encoding is the same document Requirement 29.24's ``Chain_Printer``
    produces and Requirement 29.33's ``Chain_Parser`` accepts. A pre-decoded list would
    let the JSON serialiser on the queue reshape numbers before
    :func:`effects.validate_chain` ever saw them.

    Requirement 29.28's preview and Requirement 29.14's version write are both the
    product layer's decisions (``services/effects/``): this task returns processed
    audio and says nothing about whether it should be stored.
    """
    result = apply_chain(decode(base64.b64decode(audio_base64)), parse_chain(chain_document))
    return {
        "audio_base64": base64.b64encode(encode(result.audio, audio_format)).decode("ascii"),
        "audio_format": audio_format,
        "sample_rate": result.audio.sample_rate,
        "channels": result.audio.channel_count,
        "frame_count": result.audio.frame_count,
        "duration_ms": result.duration_ms,
        "original_duration_ms": result.original_duration_ms,
        "tail_truncated": result.tail_truncated,
    }



@celery_app.task(name="musicstudio_dsp.render_mixdown")
def render_mixdown_task(
    clips: list[dict[str, Any]],
    tracks: dict[str, dict[str, Any]] | None = None,
    sample_rate: int = 48_000,
    channels: int = 2,
    peak_normalise: bool = True,
    audio_format: AudioFormat = STORAGE_FORMAT,
) -> dict[str, Any]:
    """Requirements 28.24–28.29. Shell over :func:`mixdown.render_mixdown`.

    ``clips`` is the **render target set**: Requirements 28.19 and 28.20 have been
    applied by ``domain/timeline/render-target.ts`` before the task is queued, so an
    excluded clip arrives as an absence rather than as a flag. Each entry carries its
    own audio, base64-encoded in the storage format, because a worker that fetched from
    object storage itself would put a network round trip inside the arithmetic that
    Requirement 28.27 requires to be reproducible.

    ``tracks`` is keyed by track index as a *string*: JSON object keys are strings, and
    converting here rather than trusting the transport keeps the task callable from a
    plain JSON client. Absent keys render at unity gain and centre pan.
    """
    settings = RenderParams(
        sample_rate=sample_rate, channels=channels, peak_normalise=peak_normalise
    )
    result = render_mixdown(
        [
            ClipRender(
                clip_id=str(clip["clip_id"]),
                audio=decode(base64.b64decode(clip["audio_base64"])),
                start_time_ms=int(clip["start_time_ms"]),
                track=int(clip["track"]),
                trim_start_ms=int(clip.get("trim_start_ms", 0)),
                trim_end_ms=int(clip.get("trim_end_ms", 0)),
                gain_db=float(clip.get("gain_db", 0.0)),
                fade_in_ms=int(clip.get("fade_in_ms", 0)),
                fade_out_ms=int(clip.get("fade_out_ms", 0)),
                effect_chain=tuple(clip.get("effect_chain", ())),
            )
            for clip in clips
        ],
        tracks={
            int(index): TrackRender(
                volume_db=float(setting.get("volume_db", 0.0)),
                pan=float(setting.get("pan", 0.0)),
            )
            for index, setting in (tracks or {}).items()
        },
        params=settings,
    )
    return {
        "audio_base64": base64.b64encode(encode(result.audio, audio_format)).decode("ascii"),
        "audio_format": audio_format,
        "sample_rate": result.audio.sample_rate,
        "channels": result.audio.channel_count,
        "frame_count": result.audio.frame_count,
        "duration_ms": result.audio.duration_ms,
        # Requirements 28.24 and 28.28: 0 dB when the sum fit, the applied figure when
        # it did not. Reported rather than recomputed, so the `mix` asset's metadata
        # records what happened instead of what should have.
        "attenuation_db": result.attenuation_db,
        "peak_before": result.peak_before,
        "peak_after": result.peak_after,
    }


@celery_app.task(name="musicstudio_dsp.waveform")
def waveform_task(audio_base64: str, buckets: int) -> dict[str, Any]:
    """Requirement 12.7. Shell over :func:`waveform.reduce_to_waveform`.

    Returns two parallel arrays rather than a list of pairs: the result crosses a JSON
    boundary and then a network, and ``{"min": [...], "max": [...]}`` is roughly half the
    bytes of ``[{"min": ..., "max": ...}, ...]`` for a drawing that may hold 4000 buckets.
    """
    audio = decode(base64.b64decode(audio_base64))
    reduced = reduce_to_waveform(audio, buckets)
    return {
        "buckets": len(reduced),
        "min": [bucket.min for bucket in reduced],
        "max": [bucket.max for bucket in reduced],
        "duration_ms": audio.duration_ms,
        "channels": audio.channel_count,
        "sample_rate": audio.sample_rate,
    }


@celery_app.task(name="musicstudio_dsp.measure_loudness")
def measure_loudness_task(audio_base64: str) -> dict[str, Any]:
    """Requirements 30.22, 30.24. Shell over :func:`loudness.measure`.

    Both the unrounded and the reported forms cross the seam. Requirement 30.24's rounding
    is for *reporting*, while Requirements 30.6 and 30.8 are judged on full precision, so a
    task that returned only one of the two would force the product layer either to re-round
    or to compare a bound of 0.1 against numbers already quantised to 0.1.
    """
    report = measure(decode(base64.b64decode(audio_base64)))
    return {"measurement": report.as_dict(), "reported": report.reported().as_dict()}


@celery_app.task(name="musicstudio_dsp.normalise_loudness")
def normalise_loudness_task(
    audio_base64: str,
    target_lufs: float | None = None,
    target_tolerance_lufs: float | None = None,
    audio_format: AudioFormat = STORAGE_FORMAT,
) -> dict[str, Any]:
    """Requirements 30.6, 30.7, 30.8, 30.25. Shell over :func:`mastering.normalise_loudness`.

    ``target_tolerance_lufs`` is a parameter rather than a constant because it is a
    Quality_Threshold_Set member and Requirement 34.4 lets an operator change it between two
    runs; the product layer sends the value in force. Omitted, the worker falls back to the
    initial value in ``mastering_registry.json``.
    """
    result = normalise_loudness(
        decode(base64.b64decode(audio_base64)),
        target_lufs,
        target_tolerance_lufs=target_tolerance_lufs,
    )
    return {
        "audio_base64": base64.b64encode(encode(result.audio, audio_format)).decode("ascii"),
        "audio_format": audio_format,
        "sample_rate": result.audio.sample_rate,
        "channels": result.audio.channel_count,
        "frame_count": result.audio.frame_count,
        "before": result.before.as_dict(),
        "after": result.after.as_dict(),
        "applied_gain_db": result.applied_gain_db,
        "requested_gain_db": result.requested_gain_db,
        "true_peak_limited": result.true_peak_limited,
        "target_missed": result.target_missed,
        "measurable": result.measurable,
        "target_lufs": result.target_lufs,
        "shortfall_lufs": result.shortfall_lufs,
    }


@celery_app.task(name="musicstudio_dsp.clean_dialogue")
def clean_dialogue_task(
    audio_base64: str,
    speech_rms_threshold_db: float | None = None,
    speech_min_duration_ms: float | None = None,
    non_speech_attenuation_db: float | None = None,
    audio_format: AudioFormat = STORAGE_FORMAT,
) -> dict[str, Any]:
    """Requirements 30.9, 30.10. Shell over :func:`mastering.clean_dialogue`."""
    result = clean_dialogue(
        decode(base64.b64decode(audio_base64)),
        rms_threshold_db=speech_rms_threshold_db,
        min_duration_ms=speech_min_duration_ms,
        attenuation_db=non_speech_attenuation_db,
    )
    return {
        "audio_base64": base64.b64encode(encode(result.audio, audio_format)).decode("ascii"),
        "audio_format": audio_format,
        "sample_rate": result.audio.sample_rate,
        "channels": result.audio.channel_count,
        "frame_count": result.audio.frame_count,
        "speech_regions": [region.as_dict() for region in result.speech_regions],
        # `-inf` is not valid JSON, so an unmeasurable level crosses as `null`. The product
        # layer branches on `has_non_speech` rather than on the value, for the reason
        # `services/mastering/ports.ts` states.
        "non_speech_rms_before_db": _finite(result.non_speech_rms_before_db),
        "non_speech_rms_after_db": _finite(result.non_speech_rms_after_db),
        "speech_loudness_before_lufs": _finite(result.speech_loudness_before_lufs),
        "speech_loudness_after_lufs": _finite(result.speech_loudness_after_lufs),
        "input_duration_ms": result.input_duration_ms,
        "output_duration_ms": result.output_duration_ms,
        "applied_floor_db": result.applied_floor_db,
        "has_non_speech": result.has_non_speech,
    }


@celery_app.task(name="musicstudio_dsp.duck")
def duck_task(
    dialogue_base64: str,
    music_base64: str,
    depth_db: float | None = None,
    attack_ms: float | None = None,
    release_ms: float | None = None,
    speech_rms_threshold_db: float | None = None,
    speech_min_duration_ms: float | None = None,
    audio_format: AudioFormat = STORAGE_FORMAT,
) -> dict[str, Any]:
    """Requirements 30.12–30.17. Shell over :func:`mastering.duck`.

    Two audio payloads because Requirement 30.12's operation is asymmetric: speech is
    detected in the dialogue track and the *music* track is the one attenuated. Only the
    music track comes back — the dialogue track is read and never modified.
    """
    result = duck(
        decode(base64.b64decode(dialogue_base64)),
        decode(base64.b64decode(music_base64)),
        depth_db=depth_db,
        attack_ms=attack_ms,
        release_ms=release_ms,
        rms_threshold_db=speech_rms_threshold_db,
        min_duration_ms=speech_min_duration_ms,
    )
    return {
        "audio_base64": base64.b64encode(encode(result.audio, audio_format)).decode("ascii"),
        "audio_format": audio_format,
        "sample_rate": result.audio.sample_rate,
        "channels": result.audio.channel_count,
        "frame_count": result.audio.frame_count,
        "speech_regions": [region.as_dict() for region in result.speech_regions],
        "automation_points": result.automation_as_dicts(),
        "duration_ms": result.duration_ms,
    }


def _finite(value: float) -> float | None:
    """`-inf`/`inf`/`NaN` as `null`, since none of them is valid JSON.

    The TypeScript side reads `null` back as `-Infinity`. Encoding it as a large negative
    number instead would make a silent section look like a very quiet one, which is exactly
    the distinction Requirement 30.6 turns on.
    """
    import math

    return None if not math.isfinite(value) else value



@celery_app.task(name="musicstudio_dsp.cue_pack_similarity")
def cue_pack_similarity_task(
    cues: list[dict[str, str]], similarity_ceiling: float | None = None
) -> dict[str, Any]:
    """Requirements 24.7, 24.9. Shell over :mod:`musicstudio_dsp.mfcc`.

    One task for the whole pack rather than one per pair, because Requirement 24.9's
    subject *is* the pack: 78 cues yield 3003 pairs, and the vectors are computed once
    each and compared exhaustively in a single matrix product. Enqueuing 3003 pair tasks
    would recompute each vector 77 times and would let a partial result look complete.

    Each entry carries the cue name and its base64 audio. The 24.7 pack loudness comes
    back alongside, because both quantities are per-cue measurements over the same decoded
    buffer and decoding 78 cues twice for two tasks would be the expensive part done twice.

    ``similarity_ceiling`` is a parameter, not a constant: it is a Quality_Threshold_Set
    member (``cue_pair_similarity_max``) and Requirement 34.4 lets an operator change it
    between two runs, so the product layer sends the value in force.
    """
    names = [str(entry["name"]) for entry in cues]
    buffers = [decode(base64.b64decode(entry["audio_base64"])) for entry in cues]
    vectors = [mfcc_vector(buffer) for buffer in buffers]
    report = similarity_report(
        vectors,
        CUE_PAIR_SIMILARITY_CEILING if similarity_ceiling is None else similarity_ceiling,
    )

    return {
        "cue_names": names,
        "mfcc_vectors": [[float(value) for value in vector] for vector in vectors],
        "similarity": report.as_dict(),
        # Requirement 24.7's quantity per cue, in the order the cues arrived.
        "pack_loudness_lufs": [
            _finite(max_short_term_loudness_lufs(buffer)) for buffer in buffers
        ],
    }


@celery_app.task(name="musicstudio_dsp.export_sound_pack")
def export_sound_pack_task(
    cues: list[dict[str, str]], manifest_document: str
) -> dict[str, Any]:
    """Requirements 24.10, 24.11. Shell over :func:`sound_pack.export_pack`.

    ``manifest_document`` crosses as the text ``Manifest_Printer`` produced and is stored
    verbatim — see :func:`sound_pack.export_pack` on why the worker must not reformat it.

    The archive comes back base64-encoded for the reason the module docstring gives about
    every audio payload here: the serializer is JSON. ``elapsed_ms`` is returned rather
    than compared against Requirement 24.10's 60 seconds, because that comparison is a
    Quality_Threshold_Set judgement and belongs to the product layer.
    """
    result = export_pack(
        [
            CueSource(
                name=str(entry["name"]),
                category=str(entry.get("category", "")),
                audio=decode(base64.b64decode(entry["audio_base64"])),
            )
            for entry in cues
        ],
        manifest_document,
    )
    return {
        "archive_base64": base64.b64encode(result.archive).decode("ascii"),
        **result.as_dict(),
    }
