"""13-dimension MFCC and cue-pair timbral similarity (Requirement 24.9).

Requirement 24.9 states the whole recipe, and this module follows it clause by
clause rather than delegating to a library's defaults::

    두 큐 오디오를 각각 48000Hz 모노로 변환하고 -23LUFS로 라우드니스 정규화한 뒤
    25밀리초 창·10밀리초 간격·멜 밴드 40개의 로그 멜 스펙트로그램에서 산출한
    켑스트럼 계수 중 1차부터 13차까지를 전체 창에 대해 시간 평균한 13차원 벡터를
    구하고, 두 벡터 사이의 코사인 유사도를 -1.0 이상 1.0 이하 값으로 계산하여
    0.95 이하로 유지한다

So: mono at 48 kHz, normalised to −23 LUFS, a 25 ms / 10 ms / 40-band log mel
spectrogram, cepstral orders 1..13, averaged over frames, compared by cosine
similarity.

### Why this is numpy/scipy and not ``librosa``

Design §5.5 names ``librosa`` for "온셋 검출, 멜 스펙트로그램, MFCC", and this module
deliberately does not use it. The reason is the same one
:mod:`musicstudio_dsp.loudness` gives for computing octave bands by direct FFT, and it
is a CI fact rather than a preference:

* **CI runs ``pip install -e '.[dev]'`` and nothing else.** ``librosa`` lives in the
  ``audio`` extra, so every test in this module would *skip* in CI — which is how a
  perceptual check quietly stops being checked. Tasks 3.1, 3.2 and 3.3 each resolved
  the same tension by moving a dependency into the default set (``soxr``, ``celery``,
  ``pedalboard``, ``pyloudnorm``).
* **``librosa`` does not qualify for that move.** It pulls ``numba`` — a JIT with a
  hard, narrow pin on the LLVM runtime and on the NumPy ABI — for a first import cost
  measured in seconds. Adding it to satisfy one function would make the DSP
  environment resolvable only in the intersection of two version matrices.
* **The function is small and exactly specified.** A 13-coefficient MFCC is a mel
  filterbank over an ``rfft`` this package already takes, a logarithm, and a DCT-II
  that ``scipy.fft`` provides. There is no model, no heuristic and no tuning: every
  number in the pipeline is named by Requirement 24.9. Implementing it here means the
  clause is transcribed once, in one place, and pinned by tests — rather than being
  approximated by whichever defaults a library version happens to ship.

``scipy`` is already a default dependency: ``pyloudnorm`` requires it, so ``scipy.fft``
costs no new wheel.

**Stated consequence:** ``librosa`` remains in the ``audio`` extra and nothing in the
ordinary suite needs it. If a later task wants ``librosa``'s onset detector, that task
owns the decision and the CI consequence.

### The two conventions Requirement 24.9 does not fix

The clause fixes the window, the hop and the band count, and leaves two things open.
Both are stated here as constants so a change is visible rather than implicit:

1. **The mel scale.** :data:`MEL_SCALE` is the HTK formula
   ``2595·log10(1 + f/700)``, which is the one every textbook MFCC uses and the one
   ``librosa``'s ``htk=True`` produces. Slaney's piecewise-linear-below-1 kHz variant
   would give a different — and equally defensible — 13-vector; what matters is that a
   pack measured today and one measured next year are measured the same way, so the
   choice is pinned rather than inherited.
2. **The band edge range.** 0 Hz to Nyquist. UI cues carry meaningful energy at both
   ends — a ``typing`` cue is nearly all high-frequency click and a ``sleep`` cue is
   nearly all low-frequency fall — so narrowing the range would discard exactly the
   evidence that distinguishes them.

### Orders 1..13, not 0..12

"1차부터 13차까지" is orders one through thirteen, so ``c0`` is dropped. That is not a
detail: ``c0`` is (a scalar multiple of) the mean log energy of the frame, so keeping it
would make the similarity partly a comparison of *level* rather than of timbre.

Two mechanisms are at work, and the textbook claim about them is **not** what happens
here. Measured, not assumed:

* **The −23 LUFS normalisation is load-bearing.** It is what makes the measure
  independent of a cue's delivered level, and it does so exactly: the same cue at a
  quarter of its amplitude yields a 13-vector agreeing to 5 × 10⁻⁸, which is ``float32``
  round-off and nothing else.
* **Dropping ``c0`` removes the mean-log-energy term**, so the *first-order* level
  contribution is gone from the kept coefficients. The usual next step — "therefore
  orders 1..13 are gain-invariant on their own" — holds only while no mel band is clamped
  by :data:`LOG_FLOOR`, which is an **absolute** level. For real cue material, quiet
  bands under a decaying envelope do reach the floor: analysing one cue at a −20 LUFS
  target and at a −26 LUFS target moves coefficients by about 0.1 against a vector norm
  of roughly 6.7.

The consequence is a **parity constraint, not a curiosity**: :data:`NORMALISATION_TARGET_LUFS`
is part of the definition of the measurement, so a side of the seam that normalised to a
different target would compute a different vector for the same audio. −23 LUFS is
Requirement 24.9's number and both sides use it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Final, Sequence

import numpy as np

from .audio_buffer import AudioBuffer, SAMPLE_DTYPE, window_sample_count
from .loudness import integrated_loudness_lufs
from .resample import INTERNAL_SAMPLE_RATE

__all__ = [
    "CUE_PAIR_SIMILARITY_CEILING",
    "LOG_FLOOR",
    "MEL_BANDS",
    "MEL_SCALE",
    "MFCC_COEFFICIENTS",
    "MFCC_FIRST_ORDER",
    "NORMALISATION_TARGET_LUFS",
    "SimilarityExceedance",
    "SimilarityReport",
    "cosine_similarity",
    "hz_to_mel",
    "mel_filterbank",
    "mel_to_hz",
    "mfcc_vector",
    "pairwise_similarities",
    "similarity_report",
    "to_mono_48k",
    "window_frames",
]

#: Requirement 24.9's analysis window and hop, in milliseconds.
WINDOW_MS: Final[float] = 25.0
HOP_MS: Final[float] = 10.0

#: Requirement 24.9: 40 mel bands.
MEL_BANDS: Final[int] = 40

#: Requirement 24.9: cepstral orders 1..13 inclusive — thirteen coefficients, no ``c0``.
MFCC_FIRST_ORDER: Final[int] = 1
MFCC_COEFFICIENTS: Final[int] = 13

#: Requirement 24.9's normalisation target.
NORMALISATION_TARGET_LUFS: Final[float] = -23.0

#: Requirement 24.9's initial ceiling. A Quality_Threshold_Set member
#: (``cue_pair_similarity_max``, Requirement 34.1), so callers pass the value in force
#: and this is only the fallback — the same arrangement ``mastering.py`` uses.
CUE_PAIR_SIMILARITY_CEILING: Final[float] = 0.95

#: The mel scale in force. See the module docstring, point 1.
MEL_SCALE: Final[str] = "htk"

#: Floor applied inside the logarithm, as a power relative to full scale.
#:
#: ``1e-10`` is −100 dB, comfortably below the noise floor of any delivered UI cue and
#: below the 24-bit quantisation floor of the export formats. It exists so that a band
#: with no energy at all yields a finite log rather than ``-inf`` — a single empty band
#: would otherwise make every coefficient ``NaN`` and the similarity meaningless.
LOG_FLOOR: Final[float] = 1e-10


def hz_to_mel(hz: float | np.ndarray) -> float | np.ndarray:
    """HTK mel scale: ``2595·log10(1 + f/700)``."""
    return 2595.0 * np.log10(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def mel_to_hz(mel: float | np.ndarray) -> float | np.ndarray:
    """Inverse of :func:`hz_to_mel`."""
    return 700.0 * (10.0 ** (np.asarray(mel, dtype=np.float64) / 2595.0) - 1.0)


def window_frames(sample_rate: int, ms: float) -> int:
    """Samples in a window of ``ms``, at least 1.

    Delegates to :func:`audio_buffer.window_sample_count` rather than computing it, so
    the JavaScript half-up rounding that module documents is used here too. Python's
    :func:`round` is banker's rounding and would give 1102 samples for a 25 ms window at
    44 100 Hz where ``Math.round`` gives 1103 — a one-sample disagreement across the seam
    for exactly the inputs a window calculation hits often.
    """
    return window_sample_count(sample_rate, ms)


def _transform_length(frame_size: int) -> int:
    """The smallest power of two at or above ``frame_size``.

    A power of two because ``rfft`` is fastest there, and *at or above* the frame rather
    than truncating to it because a shorter transform would discard samples the window
    covers. At 48 kHz the 1200-sample window becomes a 2048-point transform, whose
    23.4 Hz bins put roughly two bins in the narrowest mel band — enough that no band is
    empty for a broadband cue, which is what keeps :data:`LOG_FLOOR` off the hot path.
    """
    return 1 << max(0, (frame_size - 1).bit_length())


@lru_cache(maxsize=8)
def mel_filterbank(
    sample_rate: int, transform_length: int, bands: int = MEL_BANDS
) -> np.ndarray:
    """A ``(bands, transform_length // 2 + 1)`` triangular mel filterbank.

    Slaney-style *area* normalisation is deliberately **not** applied: the filters are
    unit-height triangles, so a band's value is a weighted energy sum rather than an
    average. Area normalisation divides each band by its width in Hz, which makes a wide
    high-frequency band report less energy purely for being wide — the same hazard
    :func:`loudness.octave_band_energies_db` documents for its bands. Since every cue in
    a pack goes through the identical bank, either convention gives the same *ordering*
    of similarities; unit height is the one whose intermediate values are readable.

    Cached because the bank depends only on the rate, the transform length and the band
    count, all of which are fixed for a whole pack — 3003 pair comparisons over 78 cues
    would otherwise rebuild the same matrix 78 times.
    """
    bin_count = transform_length // 2 + 1
    nyquist = sample_rate / 2.0
    # `bands + 2` edges give `bands` triangles, each spanning three consecutive edges.
    mel_edges = np.linspace(
        float(hz_to_mel(0.0)), float(hz_to_mel(nyquist)), bands + 2, dtype=np.float64
    )
    hz_edges = np.asarray(mel_to_hz(mel_edges), dtype=np.float64)
    bin_edges = hz_edges * transform_length / float(sample_rate)

    bank = np.zeros((bands, bin_count), dtype=np.float64)
    bins = np.arange(bin_count, dtype=np.float64)
    for band in range(bands):
        lower, centre, upper = bin_edges[band], bin_edges[band + 1], bin_edges[band + 2]
        # A degenerate triangle (two coincident edges) can only happen when the band
        # count is large relative to the transform length. Placing a single unit bin at
        # the centre keeps the bank full rank rather than emitting an all-zero row,
        # which would make one coefficient constant across every cue.
        if upper <= lower:
            bank[band, min(bin_count - 1, max(0, int(round(centre))))] = 1.0
            continue
        rising = (bins - lower) / max(centre - lower, 1e-12)
        falling = (upper - bins) / max(upper - centre, 1e-12)
        bank[band] = np.clip(np.minimum(rising, falling), 0.0, None)
    return bank


def to_mono_48k(audio: AudioBuffer) -> AudioBuffer:
    """Requirement 24.9's first step: 48 000 Hz, one channel.

    Downmix **then** resample, not the other way round: resampling one channel instead
    of two halves the work and cannot change the result, because ``libsoxr`` is linear
    and the downmix is a fixed linear combination.

    The downmix is a plain mean, which is what makes a mono cue duplicated to stereo
    measure identically to the mono original. Summing without dividing would make the
    stereo presentation 6 dB louder and — because :data:`LOG_FLOOR` is absolute — could
    move a near-silent band across the floor.
    """
    if audio.channel_count == 0:
        return AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, [np.zeros(0, SAMPLE_DTYPE)])

    stacked = np.stack([channel.astype(np.float64) for channel in audio.channels], axis=0)
    mono = np.mean(stacked, axis=0)

    if audio.sample_rate == INTERNAL_SAMPLE_RATE or mono.size < 2:
        return AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, [mono])

    import soxr

    resampled = soxr.resample(
        mono.astype(np.float32), audio.sample_rate, INTERNAL_SAMPLE_RATE, quality="VHQ"
    )
    return AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, [np.asarray(resampled)])


def _normalised_to_target(audio: AudioBuffer, target_lufs: float) -> AudioBuffer:
    """Requirement 24.9's second step: a plain gain to ``target_lufs``.

    A *gain*, with no true-peak limiting. :func:`mastering.normalise_loudness` exists for
    Requirement 30.6 and applies Requirement 30.7's ceiling, which is a non-linear
    operation — it would alter the spectrum of a cue that clipped, and a similarity
    measure must not depend on whether the peak happened to land above −1 dBTP.

    Silence is left alone: its loudness is ``-inf``, so no finite gain reaches the
    target, and multiplying zeros changes nothing anyway.
    """
    loudness = integrated_loudness_lufs(audio)
    if not math.isfinite(loudness):
        return audio
    gain = 10.0 ** ((target_lufs - loudness) / 20.0)
    return AudioBuffer.from_channels(
        audio.sample_rate, [channel.astype(np.float64) * gain for channel in audio.channels]
    )


def _log_mel_spectrogram(mono: np.ndarray, sample_rate: int, bands: int) -> np.ndarray:
    """A ``(frames, bands)`` log mel spectrogram at 25 ms / 10 ms.

    A Hann window, and the *power* spectrum rather than the magnitude — the conventional
    MFCC front end. Frames run while a whole window fits; a buffer shorter than one
    window is zero-padded to exactly one frame, which is what keeps Requirement 24.4's
    0.05 s floor analysable (0.05 s is two windows at 48 kHz, so padding is only reached
    by inputs shorter than the taxonomy admits).
    """
    frame_size = window_frames(sample_rate, WINDOW_MS)
    hop = window_frames(sample_rate, HOP_MS)
    transform_length = _transform_length(frame_size)
    window = np.hanning(frame_size)
    bank = mel_filterbank(sample_rate, transform_length, bands)

    if mono.size < frame_size:
        padded = np.zeros(frame_size, dtype=np.float64)
        padded[: mono.size] = mono
        starts = [0]
        data = padded
    else:
        data = mono
        starts = list(range(0, data.size - frame_size + 1, hop))

    spectra = np.empty((len(starts), transform_length // 2 + 1), dtype=np.float64)
    for index, start in enumerate(starts):
        segment = data[start : start + frame_size] * window
        buffer = np.zeros(transform_length, dtype=np.float64)
        buffer[:frame_size] = segment
        spectra[index] = np.square(np.abs(np.fft.rfft(buffer)))

    mel_energies = spectra @ bank.T
    return np.log(np.maximum(mel_energies, LOG_FLOOR))


def mfcc_vector(
    audio: AudioBuffer,
    bands: int = MEL_BANDS,
    coefficients: int = MFCC_COEFFICIENTS,
    target_lufs: float = NORMALISATION_TARGET_LUFS,
) -> np.ndarray:
    """Requirement 24.9's 13-dimension vector for one cue.

    The whole clause in one call: mono at 48 kHz, normalised to −23 LUFS, log mel
    spectrogram at 25 ms / 10 ms over 40 bands, DCT-II, orders 1..13, averaged over
    every frame.

    The average is taken over the *coefficients*, after the transform, because that is
    what "전체 창에 대해 시간 평균한" says — and it is not the same as transforming an
    averaged spectrum: the DCT is linear, so the two agree, but the log in front of it is
    not, so averaging the spectrogram first would compare geometric means of band
    energies instead of arithmetic means of cepstra.

    Returns a ``float64`` array of length ``coefficients``. An empty buffer yields zeros,
    which :func:`cosine_similarity` treats explicitly rather than dividing by zero.
    """
    from scipy.fft import dct

    if coefficients < 1:
        raise ValueError("at least one cepstral coefficient is required")
    if bands < coefficients + MFCC_FIRST_ORDER:
        raise ValueError(
            f"{bands} mel bands cannot carry {coefficients} coefficients from order "
            f"{MFCC_FIRST_ORDER}"
        )

    mono_audio = _normalised_to_target(to_mono_48k(audio), target_lufs)
    mono = (
        mono_audio.channels[0].astype(np.float64)
        if mono_audio.channel_count
        else np.zeros(0, dtype=np.float64)
    )
    if mono.size == 0:
        return np.zeros(coefficients, dtype=np.float64)

    log_mel = _log_mel_spectrogram(mono, mono_audio.sample_rate, bands)
    # Orthonormal DCT-II — the standard MFCC transform. `norm="ortho"` makes the
    # transform its own inverse's transpose, which is what makes the gain-invariance
    # argument in the module docstring exact rather than approximate.
    cepstra = dct(log_mel, type=2, axis=-1, norm="ortho")
    kept = cepstra[:, MFCC_FIRST_ORDER : MFCC_FIRST_ORDER + coefficients]
    return np.asarray(np.mean(kept, axis=0), dtype=np.float64)


def cosine_similarity(left: np.ndarray, right: np.ndarray) -> float:
    """Cosine similarity, clamped into Requirement 24.9's ``[-1.0, 1.0]``.

    The clamp is not cosmetic. The exact cosine of a vector with itself is 1, but
    ``dot(v, v) / (|v| · |v|)`` computed in floating point can land a few ULP above it,
    and Requirement 24.9 states the result's range as part of the contract. Clamping
    keeps the returned value inside the range it is documented to be in; the error being
    absorbed is at the 1e-16 level, twelve orders below the 0.95 ceiling.

    **Zero vectors.** A zero vector has no direction, so the standard formula is
    undefined. Two zero vectors are reported as ``1.0`` and a zero against a non-zero as
    ``0.0``. That is a decision, and it is the safe one for the rule the value feeds:
    Requirement 24.22 rejects pairs *above* the ceiling, and two silent cues in a pack
    are the most duplicated pair it could contain — reporting them as maximally similar
    surfaces the defect instead of hiding it behind an undefined value.
    """
    a = np.asarray(left, dtype=np.float64).reshape(-1)
    b = np.asarray(right, dtype=np.float64).reshape(-1)
    if a.size != b.size:
        raise ValueError(f"vectors differ in length: {a.size} vs {b.size}")

    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 1.0 if norm_a == 0.0 and norm_b == 0.0 else 0.0

    value = float(np.dot(a, b) / (norm_a * norm_b))
    if math.isnan(value):
        return 0.0
    return max(-1.0, min(1.0, value))


@dataclass(frozen=True)
class SimilarityExceedance:
    """One pair over the ceiling — Requirement 24.22's return payload."""

    first_index: int
    second_index: int
    similarity: float

    def as_dict(self) -> dict[str, float | int]:
        return {
            "first_index": self.first_index,
            "second_index": self.second_index,
            "similarity": self.similarity,
        }


@dataclass(frozen=True)
class SimilarityReport:
    """Every distinct pair's similarity, plus the ones over the ceiling.

    ``pair_count`` is reported rather than inferred so a caller can check the count it
    expected: for Requirement 24.9's 78 cues it is ``78·77/2 = 3003``, and a report
    holding fewer pairs than that has not examined the pack the clause describes.
    """

    pair_count: int
    ceiling: float
    exceedances: tuple[SimilarityExceedance, ...]
    max_similarity: float

    @property
    def satisfied(self) -> bool:
        return not self.exceedances

    def as_dict(self) -> dict[str, object]:
        return {
            "pair_count": self.pair_count,
            "ceiling": self.ceiling,
            "satisfied": self.satisfied,
            "max_similarity": self.max_similarity,
            "exceedances": [entry.as_dict() for entry in self.exceedances],
        }


def pairwise_similarities(vectors: Sequence[np.ndarray]) -> list[tuple[int, int, float]]:
    """Every distinct unordered pair, in ``(i, j, similarity)`` form with ``i < j``.

    **Exhaustive, not sampled.** Requirement 24.9 quantifies over "서로 다른 모든 큐 쌍
    3003개" — all of them, by count — so this iterates the full upper triangle. Cosine
    similarity is symmetric and reflexively 1, so the upper triangle is the whole content
    of the comparison; ``n(n−1)/2`` pairs for ``n`` cues.

    The vectors are normalised once and the triangle is then a matrix product, which is
    what makes 3003 pairs cost one 78×13 multiply rather than 3003 separate norms.
    """
    count = len(vectors)
    if count < 2:
        return []

    matrix = np.stack([np.asarray(v, dtype=np.float64).reshape(-1) for v in vectors], axis=0)
    norms = np.linalg.norm(matrix, axis=1)
    zero = norms == 0.0
    safe = np.where(zero, 1.0, norms)
    unit = matrix / safe[:, None]
    gram = unit @ unit.T

    pairs: list[tuple[int, int, float]] = []
    for i in range(count):
        for j in range(i + 1, count):
            if zero[i] or zero[j]:
                # The same convention `cosine_similarity` documents, applied here rather
                # than falling out of the matrix product — a zero row would give 0.0 for
                # a zero/zero pair, which is the opposite of the wanted answer.
                pairs.append((i, j, 1.0 if zero[i] and zero[j] else 0.0))
                continue
            value = float(gram[i, j])
            pairs.append((i, j, max(-1.0, min(1.0, 0.0 if math.isnan(value) else value))))
    return pairs


def similarity_report(
    vectors: Sequence[np.ndarray], ceiling: float = CUE_PAIR_SIMILARITY_CEILING
) -> SimilarityReport:
    """Requirements 24.9 and 24.22 over a whole pack's vectors.

    ``ceiling`` is a parameter because it is a Quality_Threshold_Set member
    (``cue_pair_similarity_max``); the product layer sends the value in force.

    Exceedances are reported in ``(i, j)`` order, which for a pack whose cues are in
    taxonomy order means "the pair whose second cue was generated later is named second"
    — the cue Requirement 24.22 regenerates.
    """
    pairs = pairwise_similarities(vectors)
    exceedances = tuple(
        SimilarityExceedance(first_index=i, second_index=j, similarity=value)
        for i, j, value in pairs
        if value > ceiling
    )
    return SimilarityReport(
        pair_count=len(pairs),
        ceiling=ceiling,
        exceedances=exceedances,
        max_similarity=max((value for _, _, value in pairs), default=-1.0),
    )
