"""The two DSP operations task 3.1 owns, as plain callables (design §5.1–§5.2).

Everything here is an ordinary function over bytes. Nothing imports Celery,
nothing touches a broker, nothing reaches for storage or the network. The Celery
task shells in :mod:`musicstudio_dsp.worker` are three lines each and delegate
straight to these, which is what makes the pipeline testable at all: **no broker
is reachable from a test environment**, so any behaviour that lived inside a
task body would be untestable behaviour.

### The two operations

* :func:`normalise_for_storage` — Requirements 19.4 and 19.5. An engine's output
  arrives at whatever rate the engine emits; this brings it to 48 kHz, keeps the
  length within ±10 ms, reports the original rate for the provenance record, and
  re-encodes as 24-bit FLAC. FLAC rather than WAV for the stored copy because it
  is lossless at the same 24-bit depth (see :mod:`musicstudio_dsp.formats`) and
  roughly a quarter of the size, and Requirement 13.3 can convert out of it
  without a generational loss.

* :func:`convert_for_download` — Requirements 13.3, 13.9 and 13.10. Re-encodes a
  stored asset into the requested format at 48 kHz.

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

from .audio_buffer import AudioBuffer
from .formats import (
    AudioFormat,
    ConversionReport,
    convert,
    decode,
    encode,
)
from .resample import INTERNAL_SAMPLE_RATE, normalise_sample_rate_strict

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


def normalise_for_storage(
    data: bytes, audio_format: AudioFormat = STORAGE_FORMAT
) -> NormalisedAudio:
    """Requirements 19.4, 19.5: store engine output at 48 kHz, 24-bit, ±10 ms.

    Uses the strict resampler, so a breach of Requirement 19.5's tolerance stops
    the write rather than being recorded next to it — the clause constrains what
    is *stored*. No input can reach that breach while the target is 48 kHz (see
    :mod:`musicstudio_dsp.resample` for the bound), which is the point: the
    tolerance is satisfied structurally rather than checked hopefully.
    """
    report = normalise_sample_rate_strict(decode(data), INTERNAL_SAMPLE_RATE)
    return NormalisedAudio(
        data=encode(report.audio, audio_format),
        audio_format=audio_format,
        shape=describe_audio(report.audio),
        original_sample_rate=report.original_sample_rate,
        original_duration_ms=report.original_duration_ms,
        length_error_ms=report.length_error_ms,
        resampled=report.resampled,
    )


def convert_for_download(data: bytes, audio_format: AudioFormat) -> ConversionReport:
    """Requirements 13.3, 13.9, 13.10: the requested format, always at 48 kHz.

    Entitlement (Requirement 13.4), filename (13.6) and the AI-generation tag
    (13.7) are the Library_Service's, not the worker's: they are policy and
    metadata, and putting them here would put a licensing decision inside a DSP
    stage.
    """
    return convert(data, audio_format, INTERNAL_SAMPLE_RATE)
