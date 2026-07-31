"""Container/codec conversion for the four download formats (design §5.1, §5.5).

Requirement 13.2 offers mp3, wav and flac; Requirement 13.9 adds ogg for
``sfx`` assets; Requirement 13.3 converts on demand when the requested format
differs from the stored one; Requirement 13.10 makes every download 48 kHz.
Design §5.1 fixes 32-bit float internally and **24-bit on export** for the
lossless pair.

### Why ``libsndfile`` and not ``pydub`` first

Design §5.5 lists ``pydub`` as the *fallback* for format conversion, and this
module takes that ordering literally. The ``soundfile`` wheel bundles
``libsndfile`` 1.2.2, which encodes and decodes all four required formats in
process — WAV and FLAC at ``PCM_24``, MP3 as MPEG Layer III, OGG as Vorbis. So
the primary path needs no external binary, no subprocess and no temporary file,
which in turn means the losslessness clause of Requirement 13.3 and the 24-bit
rule of design §5.1 are provable in the ordinary test suite rather than only in
a container that happens to ship ``ffmpeg``.

``pydub`` remains behind :mod:`musicstudio_dsp.codecs` for the case
``libsndfile`` cannot serve, and it is the reason that module exists at all: it
shells out to ``ffmpeg``, so it is an availability question rather than a code
path, and it is kept out of the default dependency set.

### What "lossless" means here

For WAV and FLAC the export is 24-bit PCM, so a float sample survives to within
one 24-bit quantisation step — ``2**-23`` ≈ 1.19e-07. That is the bound
:data:`LOSSLESS_TOLERANCE` states, and it is a property of the *format choice*,
not a fudge factor: asking for bit-exact equality of ``float32`` through a
24-bit container would be asking for something the container cannot represent.
MP3 and OGG are lossy by construction and only their *length* is constrained, by
the same ±10 ms tolerance Requirement 19.5 uses.

One measured subtlety, since it is the kind of thing that gets assumed and is
false: **WAV and FLAC do not decode to bit-identical floats.** ``libsndfile``
scales ``float32`` to and from 24-bit integers slightly differently on the two
paths, so about 40% of samples come back one LSB apart — within the tolerance
above, but not equal. Both are individually lossless to within a step, and
repeated conversion between them does not *accumulate* error (the offset is a
fixed difference in interpretation, not a drift), which is what Requirement
13.3 needs: an asset converted on every download must not degrade. Both claims
are pinned by tests, because only the second one is obvious once the first is
known.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Final, Literal, Mapping, get_args

import numpy as np
import soundfile as sf

from .audio_buffer import AudioBuffer, from_interleaved, to_interleaved
from .resample import (
    INTERNAL_SAMPLE_RATE,
    ResampleReport,
    normalise_sample_rate_strict,
)

__all__ = [
    "DOWNLOAD_FORMATS",
    "EXPORT_SUBTYPES",
    "LOSSLESS_FORMATS",
    "LOSSLESS_TOLERANCE",
    "SFX_DOWNLOAD_FORMATS",
    "AudioFormat",
    "ConversionReport",
    "UnsupportedFormatError",
    "convert",
    "decode",
    "encode",
    "is_lossless",
]

AudioFormat = Literal["mp3", "wav", "flac", "ogg"]

#: Requirement 13.2 — every ``Asset_Kind``.
DOWNLOAD_FORMATS: Final[tuple[AudioFormat, ...]] = ("mp3", "wav", "flac")

#: Requirement 13.9 — ``sfx`` additionally offers ogg.
SFX_DOWNLOAD_FORMATS: Final[tuple[AudioFormat, ...]] = ("mp3", "wav", "flac", "ogg")

#: Requirement 13.4 gates these two behind the lossless-download entitlement.
LOSSLESS_FORMATS: Final[frozenset[str]] = frozenset({"wav", "flac"})

#: One 24-bit quantisation step. See the module docstring.
LOSSLESS_TOLERANCE: Final[float] = 2.0**-23

#: ``libsndfile`` (format, subtype) per download format. Design §5.1's 24-bit export.
EXPORT_SUBTYPES: Final[Mapping[AudioFormat, tuple[str, str]]] = {
    "wav": ("WAV", "PCM_24"),
    "flac": ("FLAC", "PCM_24"),
    "mp3": ("MP3", "MPEG_LAYER_III"),
    "ogg": ("OGG", "VORBIS"),
}


class UnsupportedFormatError(ValueError):
    """Raised for a format outside the four of Requirements 13.2 and 13.9.

    Carries the allowed list, because Requirement 13.15's rejection shape is
    "위반된 제약과 허용값" — the caller is told what it may ask for instead.
    """

    def __init__(self, requested: str) -> None:
        allowed = ", ".join(SFX_DOWNLOAD_FORMATS)
        super().__init__(f"unsupported audio format {requested!r}; allowed: {allowed}")
        self.requested = requested
        self.allowed = SFX_DOWNLOAD_FORMATS


def is_lossless(audio_format: AudioFormat) -> bool:
    """True for the formats that survive a round trip within a 24-bit step."""
    return audio_format in LOSSLESS_FORMATS


def _validated(audio_format: str) -> AudioFormat:
    if audio_format not in get_args(AudioFormat):
        raise UnsupportedFormatError(audio_format)
    return audio_format  # type: ignore[return-value]


def encode(audio: AudioBuffer, audio_format: AudioFormat) -> bytes:
    """Encode ``audio`` into ``audio_format``, 24-bit for the lossless pair.

    The buffer's own sample rate is written, not the internal rate: encoding is
    a container concern, and forcing 48 kHz here would silently resample without
    reporting the length error Requirement 19.5 wants measured. :func:`convert`
    is the entry point that normalises the rate first.
    """
    container, subtype = EXPORT_SUBTYPES[_validated(audio_format)]
    if not audio.is_well_formed:
        raise ValueError("cannot encode a buffer that is not well formed")

    target = io.BytesIO()
    sf.write(
        target,
        to_interleaved(audio),
        audio.sample_rate,
        format=container,
        subtype=subtype,
    )
    return target.getvalue()


def decode(data: bytes) -> AudioBuffer:
    """Decode any container ``libsndfile`` recognises into ``float32`` PCM.

    The container is detected from the bytes rather than taken as an argument,
    so a caller that received a file whose extension lies about its contents
    still gets the truth — which is what Requirement 19.12's upload validation
    has to check against.
    """
    with sf.SoundFile(io.BytesIO(data)) as handle:
        samples = handle.read(dtype="float32", always_2d=True)
        sample_rate = int(handle.samplerate)
    return from_interleaved(np.asarray(samples, dtype=np.float32), sample_rate)


@dataclass(frozen=True)
class ConversionReport:
    """One conversion, plus the evidence Requirements 13.10 and 19.5 need recorded."""

    data: bytes
    audio_format: AudioFormat
    audio: AudioBuffer
    resample: ResampleReport

    @property
    def sample_rate(self) -> int:
        return self.audio.sample_rate

    @property
    def lossless(self) -> bool:
        return is_lossless(self.audio_format)


def convert(
    data: bytes,
    audio_format: AudioFormat,
    target_sample_rate: int = INTERNAL_SAMPLE_RATE,
) -> ConversionReport:
    """Requirement 13.3: re-encode stored bytes into the requested format.

    Decode, normalise the rate to 48 kHz under the ±10 ms tolerance of
    Requirement 19.5, then encode. The rate normalisation is inside the
    conversion rather than beside it because Requirement 13.10 admits no
    exception: a download is 48 kHz whatever the stored asset was.
    """
    requested = _validated(audio_format)
    decoded = decode(data)
    report = normalise_sample_rate_strict(decoded, target_sample_rate)
    return ConversionReport(
        data=encode(report.audio, requested),
        audio_format=requested,
        audio=report.audio,
        resample=report,
    )
