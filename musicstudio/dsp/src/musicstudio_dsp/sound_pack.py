"""Sound_Pack export and pack loudness (Requirements 24.7, 24.10, 24.11).

Two things live here, both plain callables like :mod:`musicstudio_dsp.mastering` —
:mod:`musicstudio_dsp.worker`'s task shells delegate and contain nothing worth testing,
because **no broker is reachable from a test environment**.

### The export (Requirements 24.10, 24.11)

"78개 큐 각각에 대한 mp3 파일 1개와 ogg 파일 1개, 합계 156개 오디오 파일을 48000Hz
샘플레이트로 담은 단일 압축 파일을 60초 이내에 반환한다", with the
``Cue_Pack_Manifest`` included (24.11).

* **``libsndfile``, not ``ffmpeg``.** :mod:`musicstudio_dsp.formats` encodes mp3 and ogg
  in process through the bundled ``libsndfile``, which task 3.1 proved for all four
  download formats. ``pydub`` shells out to an ``ffmpeg`` binary that is **not present
  and not installable here**, so routing 156 files through it would make the whole clause
  untestable. :mod:`musicstudio_dsp.codecs` remains the documented fallback.
* **``zipfile`` from the standard library**, deflated. A single compressed file is what
  24.10 asks for; the audio inside is already lossy, so deflate buys little on the
  payload and a lot on the manifest — which is fine, because the clause constrains the
  container's *shape*, not its ratio.
* **48 kHz is enforced, not assumed.** Every cue is normalised to the internal rate
  through :func:`resample.normalise_sample_rate_strict` before encoding, so a cue stored
  at another rate cannot slip into the archive at that rate. 24.10 admits no exception,
  the same way Requirement 13.10 admits none for downloads.

### How the 60-second budget is honoured, and how it is tested

:func:`export_pack` measures its own wall time with :func:`time.perf_counter` and returns
it as ``elapsed_ms``. It does **not** enforce the budget: whether an elapsed time is
acceptable is a Quality_Threshold_Set judgement (``sound_pack_export_budget_ms``), and
the product layer owns judgements. That split is what makes the clause testable without
waiting 60 seconds for anything — the *predicate* is pure and is tested by example over
stated elapsed values on the TypeScript side, while the measurement is tested here by
exporting a real 78-cue pack and asserting the result lands far inside the budget.

### Pack loudness (Requirement 24.7)

24.7 is **not** the gated integrated loudness of Requirement 30.24. It is the *maximum*
of the per-window loudness values over 400 ms windows at 100 ms intervals, with audio
shorter than one window measured whole. :func:`max_short_term_loudness_lufs` is the
Python side of that, mirroring ``maxShortTermLoudnessLufs`` in
``domain/audio/loudness.ts`` — see that module on why a maximum rather than a mean is
the right reading, and ``test_sound_pack.py`` for the cross-language agreement bound.

The 400 ms window at 100 ms intervals is exactly BS.1770-4's gating block at 75 %
overlap, so this reuses :mod:`musicstudio_dsp.loudness`'s K-weighting rather than adding
a second weighting path.
"""

from __future__ import annotations

import io
import math
import time
import zipfile
from dataclasses import dataclass
from typing import Final, Mapping, Sequence

import numpy as np

from .audio_buffer import AudioBuffer
from .formats import AudioFormat, encode
from .loudness import ABSOLUTE_GATE_LUFS, BLOCK_MS, LOUDNESS_OFFSET
from .resample import INTERNAL_SAMPLE_RATE, normalise_sample_rate_strict

__all__ = [
    "EXPORT_FORMATS",
    "MANIFEST_ENTRY_NAME",
    "SHORT_TERM_HOP_MS",
    "SHORT_TERM_WINDOW_MS",
    "CueSource",
    "ExportedFile",
    "PackExport",
    "export_pack",
    "max_short_term_loudness_lufs",
    "short_term_loudnesses_lufs",
]

#: Requirement 24.10: one mp3 and one ogg per cue, in this order.
EXPORT_FORMATS: Final[tuple[AudioFormat, ...]] = ("mp3", "ogg")

#: Requirement 24.11: the manifest's name inside the archive.
MANIFEST_ENTRY_NAME: Final[str] = "manifest.json"

#: Requirement 24.7's window and interval.
SHORT_TERM_WINDOW_MS: Final[float] = BLOCK_MS
SHORT_TERM_HOP_MS: Final[float] = 100.0


@dataclass(frozen=True)
class CueSource:
    """One cue's audio and the name it is filed under inside the archive.

    ``name`` is the cue name from the Semantic_Cue taxonomy, and ``category`` is its
    category — both supplied by the product layer rather than derived here, because the
    taxonomy is a product decision (``domain/sound-pack/taxonomy.ts``) and duplicating
    78 names across the language boundary would be a second declaration of it.
    """

    name: str
    category: str
    audio: AudioBuffer


@dataclass(frozen=True)
class ExportedFile:
    """Requirement 24.11's per-file facts: the path and the byte size."""

    path: str
    audio_format: AudioFormat
    byte_size: int
    duration_ms: float
    channels: int
    sample_rate: int

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "audio_format": self.audio_format,
            "byte_size": self.byte_size,
            "duration_ms": self.duration_ms,
            "channels": self.channels,
            "sample_rate": self.sample_rate,
        }


@dataclass(frozen=True)
class PackExport:
    """The archive plus the evidence Requirements 24.10 and 24.11 need."""

    archive: bytes
    files: tuple[ExportedFile, ...]
    #: Wall time of the whole export. Judged against the threshold by the product layer.
    elapsed_ms: float
    manifest_entry: str

    @property
    def file_count(self) -> int:
        """Audio files only — the manifest is not one of Requirement 24.10's 156."""
        return len(self.files)

    def as_dict(self) -> dict[str, object]:
        return {
            "files": [entry.as_dict() for entry in self.files],
            "file_count": self.file_count,
            "elapsed_ms": self.elapsed_ms,
            "manifest_entry": self.manifest_entry,
            "archive_byte_size": len(self.archive),
        }


def cue_path(cue_name: str, audio_format: AudioFormat) -> str:
    """The archive-relative path of one cue in one format.

    ``sounds/<cue>.<ext>`` — flat under one directory rather than nested by category.
    Requirement 24.11 records the category as a *field* of the manifest entry, so
    encoding it in the path too would be a second, less reliable copy: a consumer that
    read the category from the path would disagree with the manifest the moment a cue was
    recategorised.
    """
    return f"sounds/{cue_name}.{audio_format}"


def export_pack(
    cues: Sequence[CueSource],
    manifest_document: str,
    formats: Sequence[AudioFormat] = EXPORT_FORMATS,
) -> PackExport:
    """Requirements 24.10, 24.11: every cue in every format, plus the manifest, zipped.

    ``manifest_document`` is the text ``Manifest_Printer`` produced
    (``domain/sound-pack/manifest-printer.ts``) and is stored verbatim. It is *not*
    re-serialised here: Requirement 24.15's idempotence is a property of that printer,
    and a worker that reformatted the document would break it from outside the module the
    property is asserted about.

    ### How deterministic this is, precisely

    The archive's *structure* is deterministic: entries appear in cue order then format
    order, and every ``ZipInfo`` carries a fixed timestamp rather than "now" — otherwise
    two exports of the same pack would differ purely by the minute they ran, and nothing
    downstream could compare or cache them.

    The archive's *bytes* are **not**, and cannot be. Measured with ``libsndfile`` 1.2.2:
    encoding one buffer twice gives byte-identical wav, flac and **mp3**, but differing
    **ogg** — libvorbis writes a randomly chosen stream serial number into every Ogg page
    header. It is part of the container format (it is what lets multiplexed streams be
    told apart) and there is no libsndfile option to fix it. So an ogg file, and therefore
    the archive containing one, differs between two exports of identical audio while
    decoding to identical samples.

    Consequence, stated so nothing downstream assumes otherwise: an exported pack must be
    compared by decoded content or by manifest, never by archive hash. ``test_sound_pack.py``
    pins both halves — the structure is stable, the ogg bytes are not.
    """
    started = time.perf_counter()
    buffer = io.BytesIO()
    files: list[ExportedFile] = []

    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for cue in cues:
            # Requirement 24.10's 48 kHz, enforced per cue rather than assumed.
            report = normalise_sample_rate_strict(cue.audio, INTERNAL_SAMPLE_RATE)
            normalised = report.audio
            for audio_format in formats:
                data = encode(normalised, audio_format)
                path = cue_path(cue.name, audio_format)
                archive.writestr(_entry(path), data)
                files.append(
                    ExportedFile(
                        path=path,
                        audio_format=audio_format,
                        byte_size=len(data),
                        duration_ms=normalised.duration_ms,
                        channels=normalised.channel_count,
                        sample_rate=normalised.sample_rate,
                    )
                )
        archive.writestr(_entry(MANIFEST_ENTRY_NAME), manifest_document)

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return PackExport(
        archive=buffer.getvalue(),
        files=tuple(files),
        elapsed_ms=elapsed_ms,
        manifest_entry=MANIFEST_ENTRY_NAME,
    )


#: Fixed archive timestamp. Any valid DOS date; the point is that it is not "now".
_FIXED_DATE_TIME: Final[tuple[int, int, int, int, int, int]] = (1980, 1, 1, 0, 0, 0)


def _entry(path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=path, date_time=_FIXED_DATE_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    # 0o644, in the high 16 bits where zip keeps the Unix mode.
    info.external_attr = 0o644 << 16
    return info


def short_term_loudnesses_lufs(
    audio: AudioBuffer,
    window_ms: float = SHORT_TERM_WINDOW_MS,
    hop_ms: float = SHORT_TERM_HOP_MS,
) -> tuple[float, ...]:
    """Requirement 24.7's per-window loudness values, in window order.

    K-weighted and channel-summed exactly as BS.1770-4 blocks are — the weighting comes
    from :mod:`musicstudio_dsp.loudness`, so there is one K-weighting implementation on
    this side of the seam and not two — but **ungated**: 24.7 asks for the maximum of the
    window values, and a gate exists to exclude quiet blocks from a *mean*.

    A buffer shorter than one window is measured as a single window over the whole
    buffer, which is 24.7's own instruction ("오디오 길이가 400밀리초 미만인 큐는 전체
    구간을 1개 창으로 측정") and, conveniently, the same accommodation
    :func:`loudness.integrated_loudness_lufs` already makes for short buffers.
    """
    from .loudness import _k_weighted  # noqa: PLC0415 - internal, shared weighting path

    if not audio.is_well_formed:
        return ()

    weighted = _k_weighted(audio)
    frames = weighted.shape[1]
    window = max(1, int(round(audio.sample_rate * window_ms / 1000.0)))
    hop = max(1, int(round(audio.sample_rate * hop_ms / 1000.0)))
    effective = min(window, frames)

    values: list[float] = []
    start = 0
    while start + effective <= frames:
        segment = weighted[:, start : start + effective]
        mean_square = float(np.sum(np.mean(np.square(segment), axis=1)))
        values.append(
            -math.inf if mean_square <= 0.0 else LOUDNESS_OFFSET + 10.0 * math.log10(mean_square)
        )
        start += hop
    return tuple(values)


def max_short_term_loudness_lufs(
    audio: AudioBuffer,
    window_ms: float = SHORT_TERM_WINDOW_MS,
    hop_ms: float = SHORT_TERM_HOP_MS,
) -> float:
    """Requirement 24.7's quantity: the largest per-window loudness, or ``-inf``.

    ``-inf`` for silence, by the same rule and for the same reason
    :func:`loudness.integrated_loudness_lufs` uses it: a floor would make a silent cue
    look like a quiet one that happened to sit inside the −25…−21 LUFS band.
    """
    values = short_term_loudnesses_lufs(audio, window_ms, hop_ms)
    return max(values, default=-math.inf)


def measurable(audio: AudioBuffer) -> bool:
    """Whether any window rises above the −70 LUFS absolute gate.

    Not part of 24.7's arithmetic — 24.7 is ungated — but the product layer needs to tell
    "this cue is silent" from "this cue is quiet and outside the band", and the two lead
    to different messages for the user.
    """
    value = max_short_term_loudness_lufs(audio)
    return math.isfinite(value) and value > ABSOLUTE_GATE_LUFS


def manifest_bytes(archive: bytes, entry: str = MANIFEST_ENTRY_NAME) -> bytes:
    """Read one entry back out of an exported archive.

    Exists so a test can assert Requirement 24.11's inclusion by reading the archive
    rather than by trusting the writer, and so the product layer can verify an archive it
    received without unzipping to disk.
    """
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        return handle.read(entry)


def archive_paths(archive: bytes) -> tuple[str, ...]:
    """Every entry name in an exported archive, in stored order."""
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        return tuple(handle.namelist())


def archive_sizes(archive: bytes) -> Mapping[str, int]:
    """Uncompressed byte size per entry — Requirement 24.11's ``byte_size``, verified."""
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        return {info.filename: info.file_size for info in handle.infolist()}
