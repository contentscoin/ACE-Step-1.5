"""The two DSP operations task 3.1 owns, as plain callables (design §5.1–§5.2).

Everything here is an ordinary function over bytes. Nothing imports Celery,
nothing touches a broker, nothing reaches for storage or the network. The Celery
task shells in :mod:`musicstudio_dsp.worker` are three lines each and delegate
straight to these, which is what makes the pipeline testable at all: **no broker
is reachable from a test environment**, so any behaviour that lived inside a
task body would be untestable behaviour.

### The two operations

* :func:`normalise_for_storage` — Requirements 19.4, 19.5 and 16.6. An engine's
  output arrives at whatever rate the engine emits; this brings it to 48 kHz,
  keeps the length within ±10 ms, reports the original rate for the provenance
  record, **marks it** (see below), and re-encodes as 24-bit FLAC. FLAC rather
  than WAV for the stored copy because it is lossless at the same 24-bit depth
  (see :mod:`musicstudio_dsp.formats`) and roughly a quarter of the size, and
  Requirement 13.3 can convert out of it without a generational loss.

* :func:`convert_for_download` — Requirements 13.3, 13.9, 13.10 and 13.7.
  Re-encodes a stored asset into the requested format at 48 kHz, writing the
  metadata tags the caller supplies.

### Why the watermark goes in here and not beside here

> WHEN Audio_Asset 오디오가 저장되면 … 워터마크 정보를 포함한다 (Requirement 16.6)

"When the audio is stored" is this function — it is the only path from an
engine's bytes to the stored copy. A watermarking step *beside* it would be a
step a caller can forget, and the clause has no exception for the asset whose
caller forgot. Marking after the resample rather than before is deliberate too:
resampling a marked signal would filter the carrier the detector regenerates at
the stored rate, and the mark that matters is the one in the audio that is kept.

The download path does **not** re-mark. The stored copy carries the mark and
every conversion is made from it, so a download inherits one mark rather than
accumulating one per format the user asks for.

### Where this has to agree with the TypeScript product layer

The product layer already declares the ports whose real implementation this
worker becomes. The agreements are numeric, so they are listed rather than
assumed:

* ``domain/audio/pcm.ts`` — ``PcmAudio`` is de-interleaved ``float32`` in
  nominal ``[-1, 1]``; :class:`musicstudio_dsp.audio_buffer.AudioBuffer` is the
  same shape, and ``windowSampleCount``'s round-half-up is reproduced
  deliberately (see that module).
* ``services/sound/measurement.ts`` — ``AudioShape`` is
  ``{durationMs, sampleRate, channels}``, and :class:`AssetAudioShape` here
  reports exactly those three, unrounded, so the two implementations of
  ``measureShape`` cannot disagree by a rounding step.
* ``services/sound/sfx-ports.ts`` — the decode of engine bytes into PCM that
  task 2.5 deferred is :func:`musicstudio_dsp.formats.decode`.
* ``services/sound/v2a-ports.ts`` — the video probe, frame sampling and preview
  mux it names are **not** implemented here; they need an ``ffmpeg``/``ffprobe``
  binary, which this environment does not have, and they are outside the four
  bullets of task 3.1. :func:`musicstudio_dsp.codecs.ffmpeg_binary` is the
  availability check they will share.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from .audio_buffer import AudioBuffer
from .formats import (
    AudioFormat,
    ConversionReport,
    convert,
    decode,
    encode,
)
from .resample import INTERNAL_SAMPLE_RATE, normalise_sample_rate_strict
from .watermark import WATERMARK_VERSION, embed_watermark

__all__ = [
    "STORAGE_FORMAT",
    "AssetAudioShape",
    "NormalisedAudio",
    "convert_for_download",
    "describe_audio",
    "normalise_for_storage",
]

#: The stored representation. Lossless at design §5.1's 24-bit export depth.
STORAGE_FORMAT: AudioFormat = "flac"


@dataclass(frozen=True)
class AssetAudioShape:
    """``AudioShape`` from ``services/sound/measurement.ts``, field for field.

    ``duration_ms`` is a float and is not rounded to whole milliseconds here.
    Requirement 19.3 stores an integer millisecond length, but the rounding
    belongs to whoever writes the row: rounding at the measurement boundary
    would put a half-millisecond of slack inside the ±10 ms tolerance of
    Requirement 19.5, which is measured from this same number.
    """

    duration_ms: float
    sample_rate: int
    channels: int


def describe_audio(audio: AudioBuffer) -> AssetAudioShape:
    """Requirements 19.3, 21.10, 21.15: the shape of a decoded buffer."""
    return AssetAudioShape(
        duration_ms=audio.duration_ms,
        sample_rate=audio.sample_rate,
        channels=audio.channel_count,
    )


@dataclass(frozen=True)
class NormalisedAudio:
    """A buffer brought to the internal rate, with what Requirement 19.5 records.

    ``original_sample_rate`` is the value that goes into the asset's provenance,
    and ``resampled`` distinguishes "was already 48 kHz" from "was converted" —
    Requirement 19.5's clause only fires for the latter.
    """

    data: bytes
    audio_format: AudioFormat
    shape: AssetAudioShape
    original_sample_rate: int
    original_duration_ms: float
    length_error_ms: float
    resampled: bool
    #: Requirement 16.6's mark, as the version that made it. Goes into the
    #: asset's provenance as ``watermarkId`` (Requirement 33.14), which is what
    #: lets a later detection be checked against what was claimed at save time.
    watermark_version: int


def normalise_for_storage(
    data: bytes, audio_format: AudioFormat = STORAGE_FORMAT
) -> NormalisedAudio:
    """Requirements 19.4, 19.5, 16.6: store engine output at 48 kHz, marked.

    Uses the strict resampler, so a breach of Requirement 19.5's tolerance stops
    the write rather than being recorded next to it — the clause constrains what
    is *stored*. No input can reach that breach while the target is 48 kHz (see
    :mod:`musicstudio_dsp.resample` for the bound), which is the point: the
    tolerance is satisfied structurally rather than checked hopefully.

    The watermark is added after the resample and before the encode, and its
    version is reported rather than assumed by the caller — see the module
    docstring.
    """
    report = normalise_sample_rate_strict(decode(data), INTERNAL_SAMPLE_RATE)
    marked = embed_watermark(report.audio)
    return NormalisedAudio(
        data=encode(marked, audio_format),
        audio_format=audio_format,
        # Measured on the marked buffer, which is the one stored. The mark
        # changes no dimension of it, and a test says so rather than this
        # comment being the only thing that does.
        shape=describe_audio(marked),
        original_sample_rate=report.original_sample_rate,
        original_duration_ms=report.original_duration_ms,
        length_error_ms=report.length_error_ms,
        resampled=report.resampled,
        watermark_version=WATERMARK_VERSION,
    )


def convert_for_download(
    data: bytes,
    audio_format: AudioFormat,
    tags: Mapping[str, str] | None = None,
) -> ConversionReport:
    """Requirements 13.3, 13.7, 13.9, 13.10: the requested format, always 48 kHz.

    Entitlement (Requirement 13.4) and the filename (13.6) are the
    Library_Service's — they are policy, and deciding them here would put a
    licensing question inside a DSP stage. Requirement 13.7's AI-generation tag
    is *split* between the two: the wording is the product's
    (``domain/disclosure``), and writing it into the container is necessarily
    the encoder's, because the tag lives inside the encoded bytes. So it arrives
    here as an argument rather than being invented here or applied afterwards.
    """
    return convert(data, audio_format, INTERNAL_SAMPLE_RATE, tags)
