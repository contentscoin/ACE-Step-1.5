"""BS.1770-4 loudness and true peak, over ``pyloudnorm`` (design §5.1, §5.5).

Plain callables, like :mod:`musicstudio_dsp.effects`. Nothing here imports Celery,
touches a broker or reaches the network; :mod:`musicstudio_dsp.worker`'s task shell
delegates. That is what makes the measurements testable, because **no broker is
reachable from a test environment**.

### Agreement with the TypeScript implementation

``musicstudio/domain/audio/loudness.ts`` already measures integrated loudness in the
product layer, for the case where the samples are in hand. This module must agree with
it, and the shared reference is the standard rather than either implementation. Three
things had to be settled to make that true, and one difference remains:

1. **The filter class must be ``DeMan``, not ``pyloudnorm``'s default.**
   ``Meter(rate)`` uses ``filter_class="K-weighting"``, whose analog prototype
   parameters are *rounded* — 4.0 dB / ``1/sqrt(2)`` / 1500 Hz for the shelf and
   0.5 / 38 Hz for the RLB high-pass. Those do **not** reproduce BS.1770-4's tabulated
   48 kHz coefficients. ``filter_class="DeMan"`` uses the unrounded prototype
   (3.99984385397 / 0.7071752369554193 / 1681.9744509555319 and
   0.5003270373253953 / 38.13547087613982), which does — and which is exactly what
   ``domain/audio/k-weighting.ts`` derives. So :data:`FILTER_CLASS` is ``DeMan``, and
   ``test_loudness.py`` pins the resulting coefficients against the published table.
   Using the default would have put the two sides roughly 0.005–0.05 LUFS apart with
   nothing explaining why.
2. **Channel weights agree.** ``pyloudnorm`` uses ``G = [1, 1, 1, 1.41, 1.41]``; this
   product stores only mono and stereo (Requirement 19.3), so every channel weighs 1.0,
   which is what ``CHANNEL_WEIGHT_G`` in the TypeScript module is.
3. **Gating agrees.** Both apply the −70 LUFS absolute gate, then a relative gate 10 LU
   below the mean of the survivors. ``pyloudnorm`` uses ``>=`` on the absolute gate and
   ``>`` on the relative one; the TypeScript uses ``>`` on both. A block landing exactly
   on −70.000… LUFS would be counted by one and not the other, which no real signal does
   and which changes the result by less than the 0.1 LUFS reporting step regardless.

**The one real difference, stated rather than hidden.** For audio *shorter than one
400 ms gating block*, ``pyloudnorm`` raises ``ValueError`` — ``util.valid_audio``
refuses it. ``domain/audio/loudness.ts`` instead measures the whole buffer as a single
short block, deliberately, so that a 0.1 s sound effect (Requirement 22.4's floor) is
measurable at all. :func:`integrated_loudness_lufs` reproduces the TypeScript behaviour
in that case, using ``pyloudnorm``'s own ``DeMan`` filters for the weighting so the two
paths differ only in blocking. For anything at or above 400 ms the two implementations
run the same algorithm on the same coefficients and agree to well inside the 0.1 LUFS
Requirement 30.24 reports at; ``test_loudness.py`` asserts that bound directly.

A second, smaller difference is arithmetic rather than algorithmic: the TypeScript
filters in ``float32`` (``Float32Array`` per stage) while ``scipy.signal.lfilter`` works
in ``float64``. The gap that opens is far below the reporting step, and the tests bound
it rather than assuming it.

### True peak

Requirement 30.24 asks for "4배 이상 오버샘플링". :func:`true_peak_dbtp` upsamples by
exactly 4 with ``libsoxr`` at VHQ and takes the maximum absolute sample. Exactly 4 and
not more, because :data:`TRUE_PEAK_OVERSAMPLING` is mirrored on both sides of the seam
and a side that quietly used 8 would report a legitimately higher peak for the same
audio with the parity test having nothing to say about it.

BS.1770-4 Annex 2 specifies a particular 4× polyphase FIR; ``libsoxr`` VHQ is a
different — and steeper — interpolator. The resulting peak is within a few hundredths of
a dB of the Annex 2 filter's for real material and is never *lower*, which is the safe
direction for a ceiling that must not be exceeded (Requirement 30.7). ``soxr`` is
already a default dependency for design §5.2's resampling, so this costs no new wheel.

### Octave bands

Requirement 30.22's ten band energies are computed by Goertzel-free direct DFT over a
Hann-windowed frame set — that is, ``numpy.fft`` per frame, summed into the ten bands.
No ``librosa``: the ten bands are ten sums over an FFT this module already has to take,
and ``librosa`` would add a large dependency (with ``numba``) for a mel filterbank
nothing here needs. See :func:`octave_band_energies_db`.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from .audio_buffer import AudioBuffer, SAMPLE_DTYPE

__all__ = [
    "ABSOLUTE_GATE_LUFS",
    "BLOCK_MS",
    "FILTER_CLASS",
    "MasteringRegistry",
    "MeasurementReport",
    "RELATIVE_GATE_LU",
    "TRUE_PEAK_OVERSAMPLING",
    "integrated_loudness_lufs",
    "measure",
    "octave_band_energies_db",
    "registry",
    "round_to_step",
    "rms_db",
    "true_peak_dbtp",
]

REGISTRY_PATH = Path(__file__).with_name("mastering_registry.json")

#: The unrounded BS.1770-4 prototype. See the module docstring, point 1.
FILTER_CLASS = "DeMan"

#: Design §5.1 / Requirement 30.24. Mirrored by `LOUDNESS_BLOCK_MS` in loudness.ts.
BLOCK_MS = 400.0
BLOCK_OVERLAP = 0.75
ABSOLUTE_GATE_LUFS = -70.0
RELATIVE_GATE_LU = 10.0
#: BS.1770-4's loudness offset.
LOUDNESS_OFFSET = -0.691


@dataclass(frozen=True)
class Range:
    """An inclusive range, as Requirement 30 states them ("이상 … 이하")."""

    minimum: float
    maximum: float

    def contains(self, value: float) -> bool:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if not math.isfinite(value):
            return False
        return self.minimum <= float(value) <= self.maximum

    def describe(self) -> str:
        """Requirement 30.26's payload: the permitted range, rendered."""
        return f"{self.minimum}..{self.maximum}"


@dataclass(frozen=True)
class MasteringRegistry:
    """Requirement 30's numbers, loaded from ``mastering_registry.json``.

    ``thresholds`` are Requirement 34.3 *initial* values and serve as defaults only.
    The product layer overrides them per call with the set in force, because
    Requirement 34.4 lets an operator change them between two runs — so a function
    here takes the value as an argument and falls back to this mapping.
    """

    loudness_target_lufs: Range
    loudness_target_step_lufs: float
    loudness_target_default_lufs: float
    true_peak_ceiling_dbtp: float
    true_peak_takes_priority: bool
    true_peak_oversampling: int
    measurement_report_step: float
    ducking_depth_db: Range
    ducking_depth_default_db: float
    ducking_attack_ms: Range
    ducking_attack_default_ms: float
    ducking_release_ms: Range
    ducking_release_default_ms: float
    speech_window_ms: float
    suggestion_timeout_ms: int
    suggestion_fallback_deadline_ms: int
    octave_band_centres_hz: tuple[float, ...]
    thresholds: Mapping[str, float]

    def threshold(self, name: str) -> float:
        """An initial threshold value, for a caller that supplied no override."""
        try:
            return float(self.thresholds[name])
        except KeyError as error:  # pragma: no cover - names are parity-tested
            raise KeyError(f"unknown quality threshold '{name}'") from error


@lru_cache(maxsize=1)
def registry() -> MasteringRegistry:
    """The registry, read once.

    Cached because it is immutable and because reading it per call would put a file
    open inside the processing hot path — the same reasoning as
    :func:`musicstudio_dsp.effects.registry`.
    """
    raw: dict[str, Any] = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))

    def as_range(key: str) -> Range:
        bounds = raw[key]
        return Range(minimum=float(bounds["min"]), maximum=float(bounds["max"]))

    return MasteringRegistry(
        loudness_target_lufs=as_range("loudness_target_lufs"),
        loudness_target_step_lufs=float(raw["loudness_target_step_lufs"]),
        loudness_target_default_lufs=float(raw["loudness_target_default_lufs"]),
        true_peak_ceiling_dbtp=float(raw["true_peak_ceiling_dbtp"]),
        true_peak_takes_priority=bool(raw["true_peak_takes_priority"]),
        true_peak_oversampling=int(raw["true_peak_oversampling"]),
        measurement_report_step=float(raw["measurement_report_step"]),
        ducking_depth_db=as_range("ducking_depth_db"),
        ducking_depth_default_db=float(raw["ducking_depth_default_db"]),
        ducking_attack_ms=as_range("ducking_attack_ms"),
        ducking_attack_default_ms=float(raw["ducking_attack_default_ms"]),
        ducking_release_ms=as_range("ducking_release_ms"),
        ducking_release_default_ms=float(raw["ducking_release_default_ms"]),
        speech_window_ms=float(raw["speech_window_ms"]),
        suggestion_timeout_ms=int(raw["suggestion_timeout_ms"]),
        suggestion_fallback_deadline_ms=int(raw["suggestion_fallback_deadline_ms"]),
        octave_band_centres_hz=tuple(float(hz) for hz in raw["octave_band_centres_hz"]),
        thresholds={str(name): float(value) for name, value in raw["thresholds"].items()},
    )


#: Requirement 30.24's oversampling factor, from the shared registry.
TRUE_PEAK_OVERSAMPLING: int = registry().true_peak_oversampling


def _k_weighted(audio: AudioBuffer) -> np.ndarray:
    """Each channel K-weighted, as a ``(channels, frames)`` ``float64`` array.

    ``float64`` rather than ``float32``: ``scipy.signal.lfilter`` works in double
    precision internally anyway, and rounding back to ``float32`` between the two
    stages — which is what ``pyloudnorm``'s own in-place assignment does — costs
    precision for nothing. The TypeScript side keeps ``float32`` per stage; see the
    module docstring on why the resulting gap is bounded rather than assumed away.
    """
    import pyloudnorm as pyln

    meter = pyln.Meter(audio.sample_rate, filter_class=FILTER_CLASS)
    weighted = np.stack([channel.astype(np.float64) for channel in audio.channels], axis=0)
    for stage in meter._filters.values():  # noqa: SLF001 - the public API has no filter accessor
        for index in range(weighted.shape[0]):
            weighted[index] = stage.apply_filter(weighted[index])
    return weighted


def _loudness_of(mean_square: float) -> float:
    if mean_square <= 0:
        return -math.inf
    return LOUDNESS_OFFSET + 10.0 * math.log10(mean_square)


def integrated_loudness_lufs(audio: AudioBuffer) -> float:
    """Requirement 30.24: gated integrated loudness in LUFS, or ``-inf`` for silence.

    Delegates to ``pyloudnorm``'s ``Meter.integrated_loudness`` for audio at or above
    one 400 ms gating block, which is the whole point of depending on it: the gating
    arithmetic of BS.1770-4 is implemented and tested by a third party rather than by
    us.

    For **shorter** audio ``pyloudnorm`` refuses the input, and this function measures
    the whole buffer as a single short block instead — reproducing what
    ``domain/audio/loudness.ts`` does, for the reason that module states: a 0.1 s sound
    effect (Requirement 22.4) must stay measurable. The weighting still comes from
    ``pyloudnorm``'s ``DeMan`` filters, so only the blocking differs.

    ``-inf`` rather than a floor value, matching the TypeScript: Requirement 30.6 gates
    normalisation on there being at least one block above −70 LUFS, and a floor would
    make a silent asset look like a quiet one that could be brought up to target.
    """
    if not audio.is_well_formed:
        return -math.inf

    block_frames = max(1, int(round(audio.sample_rate * BLOCK_MS / 1000.0)))
    if audio.frame_count >= block_frames:
        import pyloudnorm as pyln

        meter = pyln.Meter(audio.sample_rate, filter_class=FILTER_CLASS)
        # `integrated_loudness` wants (frames, channels); AudioBuffer is de-interleaved.
        interleaved = np.stack(
            [channel.astype(np.float64) for channel in audio.channels], axis=1
        )
        value = float(meter.integrated_loudness(interleaved))
        # A wholly silent buffer yields -inf from the log; numpy reports it as -inf
        # already, but a NaN can appear when every block is gated out.
        return -math.inf if math.isnan(value) else value

    # The short-buffer path: one block over the whole buffer, channels summed with
    # G = 1.0 (mono/stereo only — see the module docstring, point 2).
    weighted = _k_weighted(audio)
    mean_square = float(np.sum(np.mean(np.square(weighted), axis=1)))
    return _loudness_of(mean_square)


def has_gated_block(audio: AudioBuffer) -> bool:
    """Requirement 30.6's precondition: is there a block above the −70 LUFS gate?

    Separate from :func:`integrated_loudness_lufs` because the clause conditions
    normalisation on it explicitly ("-70.0LUFS 절대 게이트를 초과하는 게이팅 블록이 1개
    이상 존재하고"), and a caller needs to distinguish "silent" from "measured very
    quietly" in order to refuse rather than to apply 60 dB of gain to noise.
    """
    loudness = integrated_loudness_lufs(audio)
    return math.isfinite(loudness) and loudness > ABSOLUTE_GATE_LUFS


def true_peak_dbtp(audio: AudioBuffer, oversampling: int = TRUE_PEAK_OVERSAMPLING) -> float:
    """Requirement 30.24: true peak in dBTP, 4× oversampled.

    ``-inf`` for a buffer that is exactly zero everywhere, by the same rule
    :func:`integrated_loudness_lufs` follows and for the same reason.

    The maximum is taken over the *oversampled* signal and over all channels, because a
    true peak is a property of the reconstructed waveform rather than of the stored
    samples — which is the whole reason BS.1770-4 asks for oversampling. Taking it
    per channel and then the maximum is the same number and is how it is written.
    """
    import soxr

    if not audio.is_well_formed:
        return -math.inf

    peak = 0.0
    target_rate = int(audio.sample_rate * oversampling)
    for channel in audio.channels:
        if channel.size == 0:
            continue
        # `soxr` needs at least a couple of samples to run its filter; a buffer that
        # short has no inter-sample peak to find, so the stored peak is the true peak.
        if channel.size < 2:
            upsampled = channel.astype(np.float64)
        else:
            upsampled = np.asarray(
                soxr.resample(
                    channel.astype(np.float32), audio.sample_rate, target_rate, quality="VHQ"
                ),
                dtype=np.float64,
            )
        channel_peak = float(np.max(np.abs(upsampled))) if upsampled.size else 0.0
        # The stored samples are part of the reconstructed waveform too, and a resampler
        # with a finite kernel can land just below one of them at the very edges of the
        # buffer. Taking both keeps the reported peak from ever understating the audio,
        # which is the safe direction for Requirement 30.7's ceiling.
        stored_peak = float(np.max(np.abs(channel.astype(np.float64))))
        peak = max(peak, channel_peak, stored_peak)

    if peak <= 0.0:
        return -math.inf
    return 20.0 * math.log10(peak)


def rms_db(samples: np.ndarray) -> float:
    """Root mean square of ``samples`` in dB, ``-inf`` for silence.

    The Python counterpart of ``rms`` + ``amplitudeToDb`` in ``domain/audio/level.ts``,
    and deliberately the same two-step shape: the RMS is computed on amplitudes and only
    then converted, so a silent window yields ``-inf`` rather than a ``NaN`` from
    ``log10(0)`` propagating into a comparison.
    """
    array = np.asarray(samples, dtype=np.float64).reshape(-1)
    if array.size == 0:
        return -math.inf
    mean_square = float(np.mean(np.square(array)))
    if mean_square <= 0.0:
        return -math.inf
    return 10.0 * math.log10(mean_square)


def octave_band_energies_db(
    audio: AudioBuffer, centres_hz: Sequence[float] | None = None
) -> tuple[float, ...]:
    """Requirement 30.22: mean energy in each of ten octave bands, in dB.

    One value per centre frequency, in the order the clause lists them — the order is
    part of the response contract, since the caller pairs the ten numbers positionally.

    ### How the bands are defined

    A full octave band around ``fc`` spans ``fc / sqrt(2)`` to ``fc * sqrt(2)``
    (IEC 61260's base-2 definition). The energy is the mean power spectral density in
    that span, summed over channels and averaged over frames, expressed in dB relative
    to full scale.

    ### Why an FFT rather than a filter bank

    Ten sums over one spectrum, versus ten IIR filters run over the whole signal. The
    FFT is cheaper, has no filter-design step to get wrong, and needs no dependency —
    design §5.5 names ``librosa`` for mel spectrograms and MFCCs, which task 3.4 needs
    and this does not. A Hann window with 50 % overlap is used so that a tone sitting
    between two bins is not split in a way that moves it out of its band.

    Bands whose whole span lies above Nyquist yield ``-inf``: at 48 kHz that is none of
    the ten, but a 16 kHz-rate asset has no 16 kHz band and reporting 0 dB for it would
    be a claim about energy that cannot exist.
    """
    bands = tuple(centres_hz if centres_hz is not None else registry().octave_band_centres_hz)
    if not audio.is_well_formed:
        return tuple(-math.inf for _ in bands)

    frame_size = _analysis_frame_size(audio.frame_count)
    hop = max(1, frame_size // 2)
    window = np.hanning(frame_size)
    # Parseval normalisation for the window. `sum_k |X(k)|² = N · sum_n |x[n]w[n]|²`, and
    # `sum_n (x·w)² ≈ mean_square(x) · sum(w²)`, so dividing the *summed* squared
    # magnitudes by `N · sum(w²)` and doubling for the single-sided spectrum recovers the
    # signal's mean square in the band. A band containing a sine of amplitude A therefore
    # reads exactly A²/2, and the ten bands sum to the signal's total mean square,
    # regardless of the window or the transform length.
    #
    # The *coherent* gain `sum(w)²` would be exact for the tone's peak bin alone and
    # 1.76 dB high once the window's skirts are summed with it — which is the whole point
    # of using the energy normalisation when summing over a band rather than reading one
    # bin.
    window_energy = float(np.sum(np.square(window)))

    accumulated = np.zeros(frame_size // 2 + 1, dtype=np.float64)
    segments = 0
    for channel in audio.channels:
        data = channel.astype(np.float64)
        for start in range(0, data.size - frame_size + 1, hop):
            spectrum = np.fft.rfft(data[start : start + frame_size] * window)
            accumulated += np.square(np.abs(spectrum))
            segments += 1

    if segments == 0:
        return tuple(-math.inf for _ in bands)

    # Averaged over segments *and* channels: the clause asks for a mean energy per band,
    # and summing channels the way BS.1770-4 sums them would make a mono asset report
    # 3.01 dB below the same signal in stereo — defensible for loudness, where the
    # standard says so, and confusing for a spectrum the user reads as a tone balance.
    mean_squared_magnitude = accumulated / segments
    bin_hz = audio.sample_rate / frame_size
    nyquist = audio.sample_rate / 2.0
    root_two = math.sqrt(2.0)

    energies: list[float] = []
    for centre in bands:
        low = centre / root_two
        high = centre * root_two
        if low >= nyquist:
            energies.append(-math.inf)
            continue
        low_bin = max(0, int(math.floor(low / bin_hz)))
        high_bin = min(mean_squared_magnitude.size - 1, int(math.ceil(min(high, nyquist) / bin_hz)))
        if high_bin < low_bin:
            energies.append(-math.inf)
            continue
        # Summed over the band's bins, not averaged: the band's energy is what is in it,
        # and averaging would report a wide band as quieter purely for spanning more bins
        # — so a tone would appear to lose 10 dB by moving from the 63 Hz band to the
        # 8 kHz one. The `2 / coherent_gain²` factor is the scaling described above.
        power = (
            float(np.sum(mean_squared_magnitude[low_bin : high_bin + 1]))
            * 2.0
            / (frame_size * window_energy)
        )
        energies.append(-math.inf if power <= 0.0 else 10.0 * math.log10(power))

    return tuple(energies)


def _analysis_frame_size(frame_count: int) -> int:
    """Transform length for the band analysis: a power of two, at most 4096.

    4096 at 48 kHz gives 11.7 Hz bins, which resolves the 31.5 Hz band (spanning 22 to
    45 Hz) into two bins — the narrowest of the ten in absolute terms and therefore the
    one that sets the requirement. Longer transforms would resolve it better and average
    over fewer segments; 4096 is the point where both are adequate.

    A buffer shorter than 256 frames is analysed whole, because a shorter transform than
    that cannot separate the two lowest bands at any sample rate this product stores.
    """
    if frame_count < 256:
        return max(1, frame_count)
    return min(4096, 1 << (frame_count.bit_length() - 1))


def round_to_step(value: float, step: float | None = None) -> float:
    """Requirement 30.24's reporting rule: round to 0.1, half away from zero.

    The Python counterpart of ``roundToStep`` in ``domain/mastering/measurement.ts``,
    and it must round the same way — otherwise the same audio reports a different
    number depending on which side measured it.

    Half **away from zero** rather than Python's banker's rounding, for two reasons that
    both matter here. Banker's rounding sends −14.05 to −14.0 and −14.15 to −14.2,
    which is not a rule anyone reading a loudness meter expects; and loudness values are
    almost always negative, so any rule that is not symmetric about zero biases every
    reported number in one direction. ``window_sample_count`` in
    :mod:`musicstudio_dsp.audio_buffer` documents the same class of hazard for
    ``round`` versus ``Math.round``.
    """
    resolved = registry().measurement_report_step if step is None else step
    if not math.isfinite(value):
        return value
    scaled = value / resolved
    rounded = math.copysign(math.floor(abs(scaled) + 0.5), scaled)
    return round(rounded * resolved, 10)


@dataclass(frozen=True)
class MeasurementReport:
    """Requirements 30.22 and 30.24's three quantities.

    Unrounded. Rounding is a *presentation* step, applied by :meth:`reported`, because
    Requirement 30.6's ±0.5 LUFS band and Requirement 30.8's ≤0.1 dB idempotence bound
    are both judged on full precision — a bound of 0.1 compared against numbers already
    quantised to 0.1 would be decided entirely by which side of a tie the rounding fell
    on. Mirrors ``MasteringMeasurement`` in ``domain/mastering/measurement.ts`` field
    for field.
    """

    integrated_loudness_lufs: float
    true_peak_dbtp: float
    octave_band_energies_db: tuple[float, ...]

    def reported(self) -> "MeasurementReport":
        """Requirement 30.24: both headline numbers quantised to 0.1.

        The band energies are left alone: 30.24's rounding rule names "두 측정값" — the
        loudness and the true peak — and 30.22 asks for the band energies as values
        without stating a precision.
        """
        return MeasurementReport(
            integrated_loudness_lufs=round_to_step(self.integrated_loudness_lufs),
            true_peak_dbtp=round_to_step(self.true_peak_dbtp),
            octave_band_energies_db=self.octave_band_energies_db,
        )

    def as_dict(self) -> dict[str, Any]:
        """JSON-serialisable form, for the Celery result backend.

        ``-inf`` is not valid JSON, so it crosses as ``None``. The TypeScript side reads
        ``null`` back as ``-Infinity``; encoding it as a large negative number instead
        would make a silent asset look like a very quiet one, which is precisely the
        distinction Requirement 30.6 turns on.
        """

        def finite(value: float) -> float | None:
            return None if not math.isfinite(value) else value

        return {
            "integrated_loudness_lufs": finite(self.integrated_loudness_lufs),
            "true_peak_dbtp": finite(self.true_peak_dbtp),
            "octave_band_energies_db": [
                finite(energy) for energy in self.octave_band_energies_db
            ],
        }


def measure(audio: AudioBuffer) -> MeasurementReport:
    """Requirements 30.22, 30.24: all three quantities in one pass over the audio."""
    return MeasurementReport(
        integrated_loudness_lufs=integrated_loudness_lufs(audio),
        true_peak_dbtp=true_peak_dbtp(audio),
        octave_band_energies_db=octave_band_energies_db(audio),
    )
