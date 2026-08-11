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
    "TAG_FIELDS",
    "AudioFormat",
    "ConversionReport",
    "UnsupportedFormatError",
    "convert",
    "decode",
    "encode",
    "is_lossless",
    "read_tags",
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


#: Container metadata fields this module will write, and the only ones.
#:
#: Requirement 13.7 puts an AI-generation marker in the download's tags, and the
#: *wording* of that marker is the product layer's — ``domain/disclosure`` owns
#: it. What is decided here is which containers can carry it, which is a
#: property of ``libsndfile`` rather than of the product: measured against 1.2.2,
#: ``comment`` and ``title`` survive all four formats, while ``software`` is
#: rewritten by the library on the way out ("… (libsndfile-1.2.2)") and dropped
#: entirely by the MP3 writer. So the marker rides in ``comment``, and a tag the
#: caller cannot rely on is not offered at all.
TAG_FIELDS: Final[tuple[str, ...]] = ("title", "artist", "comment")


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


def encode(
    audio: AudioBuffer,
    audio_format: AudioFormat,
    tags: Mapping[str, str] | None = None,
) -> bytes:
    """Encode ``audio`` into ``audio_format``, 24-bit for the lossless pair.

    The buffer's own sample rate is written, not the internal rate: encoding is
    a container concern, and forcing 48 kHz here would silently resample without
    reporting the length error Requirement 19.5 wants measured. :func:`convert`
    is the entry point that normalises the rate first.

    ``tags`` are written into the container's metadata. Only the encoder can do
    this — the tag lives inside the encoded bytes — so the *writing* is here and
    the *wording* stays with the caller. Keys outside :data:`TAG_FIELDS` are
    rejected rather than ignored, because a metadata field that silently does
    not arrive is the failure mode Requirement 13.7 is exposed to: the download
    still works, and the marker is simply absent.
    """
    container, subtype = EXPORT_SUBTYPES[_validated(audio_format)]
    if not audio.is_well_formed:
        raise ValueError("cannot encode a buffer that is not well formed")

    written = dict(tags or {})
    unknown = sorted(set(written) - set(TAG_FIELDS))
    if unknown:
        raise ValueError(
            f"unsupported metadata field(s) {', '.join(unknown)}; "
            f"supported: {', '.join(TAG_FIELDS)}"
        )

    target = io.BytesIO()
    with sf.SoundFile(
        target,
        mode="w",
        samplerate=audio.sample_rate,
        channels=audio.channel_count,
        format=container,
        subtype=subtype,
    ) as handle:
        # Before the samples: libsndfile flushes the header on the first write
        # for some containers, and a tag set afterwards would not reach the file.
        for field, value in written.items():
            setattr(handle, field, value)
        handle.write(to_interleaved(audio))
    return target.getvalue()


def read_tags(data: bytes) -> dict[str, str]:
    """The metadata fields of :data:`TAG_FIELDS` present in ``data``.

    Absent fields are omitted rather than reported as empty strings, so a caller
    checking Requirement 13.7's marker is asking "is it there" and not "is it
    there and non-empty".
    """
    with sf.SoundFile(io.BytesIO(data)) as handle:
        found = {}
        for field in TAG_FIELDS:
            value = getattr(handle, field, None)
            if value:
                found[field] = str(value)
        return found


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
    tags: Mapping[str, str] | None = None,
) -> ConversionReport:
    """Requirement 13.3: re-encode stored bytes into the requested format.

    Decode, normalise the rate to 48 kHz under the ±10 ms tolerance of
    Requirement 19.5, then encode. The rate normalisation is inside the
    conversion rather than beside it because Requirement 13.10 admits no
    exception: a download is 48 kHz whatever the stored asset was.

    Tags of the *source* are not carried over. A converted download is a new
    file and its metadata is whatever the caller asks for; inheriting the stored
    copy's tags would mean a download's marker depended on how the asset was
    stored rather than on Requirement 13.7.
    """
    requested = _validated(audio_format)
    decoded = decode(data)
    report = normalise_sample_rate_strict(decoded, target_sample_rate)
    return ConversionReport(
        data=encode(report.audio, requested, tags),
        audio_format=requested,
        audio=report.audio,
        resample=report,
    )
