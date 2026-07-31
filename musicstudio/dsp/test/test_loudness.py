"""BS.1770-4 loudness, true peak and octave bands (Requirements 30.22, 30.24).

The tests that matter most here are the ones that check the measurement against something
*other than itself*:

* the K-weighting coefficients against BS.1770-4's published 48 kHz table;
* the octave-band energies against the analytically known mean square of a synthesised
  sine, which is why every band test uses a tone whose level is arithmetic rather than
  measured;
* the scale-equivariance of both headline numbers, which is the property loudness
  normalisation is built on and the reason Requirement 30.8's idempotence holds at all.

``test_mastering.py`` owns Property 15. This file owns the measurement it is stated over.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.loudness import (
    ABSOLUTE_GATE_LUFS,
    BLOCK_MS,
    FILTER_CLASS,
    TRUE_PEAK_OVERSAMPLING,
    integrated_loudness_lufs,
    has_gated_block,
    measure,
    octave_band_energies_db,
    registry,
    rms_db,
    round_to_step,
    true_peak_dbtp,
)

SAMPLE_RATE = 48_000


def sine(
    frequency_hz: float,
    amplitude: float,
    seconds: float = 2.0,
    sample_rate: int = SAMPLE_RATE,
    channels: int = 1,
) -> AudioBuffer:
    frames = int(round(sample_rate * seconds))
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = (amplitude * np.sin(2.0 * np.pi * frequency_hz * t)).astype(np.float32)
    return AudioBuffer.from_channels(sample_rate, [wave] * channels)


def silence(seconds: float = 1.0, sample_rate: int = SAMPLE_RATE) -> AudioBuffer:
    frames = int(round(sample_rate * seconds))
    return AudioBuffer.from_channels(sample_rate, [np.zeros(frames, dtype=np.float32)])


class TestKWeighting:
    """The filter is BS.1770-4's, not ``pyloudnorm``'s rounded default."""

    def test_uses_the_unrounded_deman_prototype(self) -> None:
        # The whole reason `FILTER_CLASS` exists. `pyloudnorm`'s default "K-weighting"
        # class uses rounded prototype parameters (4.0 dB / 1500 Hz / 38 Hz) which do NOT
        # reproduce the standard's tabulated coefficients; "DeMan" does, and so does
        # `domain/audio/k-weighting.ts`.
        assert FILTER_CLASS == "DeMan"

    def test_reproduces_the_published_48khz_coefficient_table(self) -> None:
        import pyloudnorm as pyln

        meter = pyln.Meter(SAMPLE_RATE, filter_class=FILTER_CLASS)
        shelf = meter._filters["high_shelf_DeMan"]  # noqa: SLF001
        highpass = meter._filters["high_pass_DeMan"]  # noqa: SLF001

        # BS.1770-4 Tables 1 and 2, to the precision the standard prints.
        assert shelf.b == pytest.approx([1.53512485958697, -2.69169618940638, 1.19839281085285], abs=1e-11)
        assert shelf.a == pytest.approx([1.0, -1.69065929318241, 0.73248077421585], abs=1e-11)
        assert highpass.b == pytest.approx([1.0, -2.0, 1.0], abs=1e-12)
        assert highpass.a == pytest.approx([1.0, -1.99004745483398, 0.99007225036621], abs=1e-11)

    def test_the_default_filter_class_would_have_disagreed(self) -> None:
        # Stated as a test so the choice cannot be quietly reverted: the two classes give
        # measurably different answers, which is why one of them had to be picked
        # deliberately rather than by accepting the library default.
        import pyloudnorm as pyln

        audio = sine(1_000.0, 0.5)
        data = np.stack([channel.astype(np.float64) for channel in audio.channels], axis=1)

        deman = pyln.Meter(SAMPLE_RATE, filter_class="DeMan").integrated_loudness(data)
        default = pyln.Meter(SAMPLE_RATE).integrated_loudness(data)

        assert deman != pytest.approx(default, abs=1e-9)


class TestIntegratedLoudness:
    @pytest.mark.parametrize("amplitude", [1.0, 0.5, 0.25, 0.1])
    def test_a_1khz_sine_measures_its_own_mean_square(self, amplitude: float) -> None:
        # The standard's calibration point, and worth pinning precisely because it looks
        # like the −0.691 offset has gone missing. It has not: K-weighting's shelf gives
        # +0.6977 dB at 1 kHz, which cancels the offset to within 0.007 dB. So a 1 kHz sine
        # of amplitude A reads 10·log10(A²/2) LUFS — i.e. a full-scale 1 kHz sine reads
        # −3.01 LUFS, which is the number every loudness meter is checked against.
        expected = 10.0 * math.log10(amplitude**2 / 2.0)

        assert integrated_loudness_lufs(sine(1_000.0, amplitude)) == pytest.approx(
            expected, abs=0.02
        )

    def test_is_scale_equivariant(self) -> None:
        # The property every part of Requirement 30.6/30.8 rests on: scaling by g moves the
        # loudness by exactly 20·log10(g), because the filter is linear and both gates are
        # relative to the signal's own mean.
        audio = sine(440.0, 0.2)
        base = integrated_loudness_lufs(audio)

        for gain_db in (-12.0, -3.0, 3.0, 9.0):
            factor = np.float32(10.0 ** (gain_db / 20.0))
            scaled = AudioBuffer.from_channels(
                audio.sample_rate, [channel * factor for channel in audio.channels]
            )
            assert integrated_loudness_lufs(scaled) == pytest.approx(base + gain_db, abs=0.02)

    def test_stereo_measures_3_01_lu_above_the_same_signal_in_mono(self) -> None:
        # BS.1770-4's channel sum, not a bug. `domain/audio/loudness.ts` documents the same
        # consequence; asserting it here keeps the two sides' channel handling pinned
        # together.
        mono = integrated_loudness_lufs(sine(1_000.0, 0.3, channels=1))
        stereo = integrated_loudness_lufs(sine(1_000.0, 0.3, channels=2))

        assert stereo - mono == pytest.approx(3.01, abs=0.02)

    def test_silence_is_negative_infinity_rather_than_a_floor(self) -> None:
        # A floor would make a silent asset look like a quiet one that could be brought up
        # to target, which is exactly what Requirement 30.6's gate exists to prevent.
        assert integrated_loudness_lufs(silence()) == -math.inf
        assert has_gated_block(silence()) is False

    def test_measures_audio_shorter_than_one_gating_block(self) -> None:
        # `pyloudnorm` raises for this; `domain/audio/loudness.ts` measures the whole
        # buffer as a single short block, and so does this. A 0.1 s sound effect
        # (Requirement 22.4's floor) has to stay measurable.
        short = sine(1_000.0, 0.4, seconds=0.1)
        assert short.duration_ms < BLOCK_MS

        value = integrated_loudness_lufs(short)

        assert math.isfinite(value)
        # Same calibration as the full-length path: a 1 kHz sine reads its own mean square.
        assert value == pytest.approx(10.0 * math.log10(0.4**2 / 2.0), abs=0.05)

    def test_the_short_path_is_also_scale_equivariant(self) -> None:
        # The short path is a different code path, so the property normalisation depends on
        # has to be checked there too — otherwise a 0.1 s asset could not be normalised.
        short = sine(1_000.0, 0.2, seconds=0.1)
        base = integrated_loudness_lufs(short)
        factor = np.float32(10.0 ** (6.0 / 20.0))
        scaled = AudioBuffer.from_channels(
            short.sample_rate, [channel * factor for channel in short.channels]
        )

        assert integrated_loudness_lufs(scaled) == pytest.approx(base + 6.0, abs=0.02)

    def test_a_buffer_at_the_absolute_gate_has_no_measurable_loudness(self) -> None:
        # −70 LUFS is roughly amplitude 3e-4 for a sine; well below it there is nothing.
        assert has_gated_block(sine(1_000.0, 1e-6)) is False
        assert integrated_loudness_lufs(sine(1_000.0, 1e-6)) < ABSOLUTE_GATE_LUFS


class TestTruePeak:
    def test_uses_the_oversampling_factor_the_registry_declares(self) -> None:
        assert TRUE_PEAK_OVERSAMPLING == 4
        assert registry().true_peak_oversampling == 4

    def test_never_understates_the_stored_peak(self) -> None:
        # The safe direction for Requirement 30.7's ceiling: a reported peak below the real
        # one would let the ceiling be breached silently.
        audio = sine(997.0, 0.7)
        stored = max(float(np.max(np.abs(channel))) for channel in audio.channels)

        assert true_peak_dbtp(audio) >= 20.0 * math.log10(stored) - 1e-9

    def test_finds_an_inter_sample_peak_the_stored_samples_miss(self) -> None:
        # A tone at a frequency that never lands on a sample maximum. The oversampled peak
        # must exceed the stored one, which is the entire reason BS.1770-4 asks for
        # oversampling.
        rate = 48_000
        frames = rate
        t = np.arange(frames, dtype=np.float64) / rate
        # Nyquist/3-ish, phase-offset so no sample sits on a crest.
        wave = (0.5 * np.sin(2.0 * np.pi * 15_999.0 * t + 0.37)).astype(np.float32)
        audio = AudioBuffer.from_channels(rate, [wave])
        stored_db = 20.0 * math.log10(float(np.max(np.abs(wave))))

        assert true_peak_dbtp(audio) > stored_db

    def test_is_scale_equivariant(self) -> None:
        # Needed by normalisation: the admissible gain is computed as `ceiling − peak`,
        # which is only correct if the peak moves with the gain.
        audio = sine(440.0, 0.25)
        base = true_peak_dbtp(audio)

        for gain_db in (-6.0, 4.0):
            factor = np.float32(10.0 ** (gain_db / 20.0))
            scaled = AudioBuffer.from_channels(
                audio.sample_rate, [channel * factor for channel in audio.channels]
            )
            assert true_peak_dbtp(scaled) == pytest.approx(base + gain_db, abs=0.02)

    def test_silence_is_negative_infinity(self) -> None:
        assert true_peak_dbtp(silence()) == -math.inf

    def test_a_one_sample_buffer_is_still_measurable(self) -> None:
        # `soxr` needs two samples to filter; the stored peak is the answer for one.
        audio = AudioBuffer.from_channels(SAMPLE_RATE, [np.array([0.5], dtype=np.float32)])

        assert true_peak_dbtp(audio) == pytest.approx(20.0 * math.log10(0.5), abs=1e-6)


class TestOctaveBands:
    def test_reports_exactly_the_ten_centres_requirement_30_22_lists(self) -> None:
        assert registry().octave_band_centres_hz == (
            31.5,
            63.0,
            125.0,
            250.0,
            500.0,
            1000.0,
            2000.0,
            4000.0,
            8000.0,
            16000.0,
        )
        assert len(octave_band_energies_db(sine(1_000.0, 0.3))) == 10

    @pytest.mark.parametrize(
        ("frequency_hz", "amplitude", "band_index"),
        [
            (63.0, 0.25, 1),
            (250.0, 0.4, 3),
            (1_000.0, 0.5, 5),
            (8_000.0, 0.1, 8),
        ],
    )
    def test_a_tone_reads_its_own_mean_square_in_its_own_band(
        self, frequency_hz: float, amplitude: float, band_index: int
    ) -> None:
        # The band scaling is Parseval-normalised, so a sine of amplitude A inside a band
        # reads exactly 10·log10(A²/2). Checked against arithmetic, which is what makes this
        # a test of the scaling rather than a recording of it.
        energies = octave_band_energies_db(sine(frequency_hz, amplitude))
        expected = 10.0 * math.log10(amplitude**2 / 2.0)

        assert energies[band_index] == pytest.approx(expected, abs=0.1)
        assert max(energies) == pytest.approx(energies[band_index], abs=1e-9)

    def test_bands_above_nyquist_are_negative_infinity_not_zero(self) -> None:
        # A 16 kHz asset has no 16 kHz band; reporting 0 dB would be a claim about energy
        # that cannot exist.
        energies = octave_band_energies_db(sine(1_000.0, 0.3, sample_rate=16_000))

        assert energies[9] == -math.inf

    def test_silence_is_negative_infinity_in_every_band(self) -> None:
        assert all(energy == -math.inf for energy in octave_band_energies_db(silence()))

    def test_is_deterministic(self) -> None:
        # Requirement 30.18 over the analysis as well as the processing: the same audio must
        # report the same spectrum, or the suggestion it feeds would not be reproducible.
        audio = sine(440.0, 0.3)
        assert octave_band_energies_db(audio) == octave_band_energies_db(audio)


class TestRounding:
    def test_rounds_to_the_0_1_step_requirement_30_24_reports_at(self) -> None:
        assert round_to_step(-14.34) == -14.3
        assert round_to_step(-14.36) == -14.4

    def test_rounds_halves_away_from_zero_in_both_directions(self) -> None:
        # Not banker's rounding, and symmetric about zero. Loudness values are almost
        # always negative, so an asymmetric rule would bias every reported number.
        assert round_to_step(-14.05) == -14.1
        assert round_to_step(14.05) == 14.1
        assert round_to_step(-14.15) == -14.2
        assert round_to_step(14.15) == 14.2

    def test_does_not_leak_float_error_into_the_reported_value(self) -> None:
        # `round(143 * 0.1, ...)` is 14.299999999999999 without the final rounding, which
        # would contradict "0.1 단위".
        assert round_to_step(-14.29) == -14.3
        assert repr(round_to_step(-14.29)) == "-14.3"

    def test_leaves_infinities_alone(self) -> None:
        assert round_to_step(-math.inf) == -math.inf


class TestRmsDb:
    def test_matches_the_arithmetic_for_a_sine(self) -> None:
        t = np.arange(SAMPLE_RATE, dtype=np.float64) / SAMPLE_RATE
        wave = 0.5 * np.sin(2.0 * np.pi * 100.0 * t)

        assert rms_db(wave) == pytest.approx(10.0 * math.log10(0.25 / 2.0), abs=0.01)

    def test_silence_is_negative_infinity_rather_than_nan(self) -> None:
        # The two-step shape `domain/audio/level.ts` uses, and for the same reason: a NaN
        # here would propagate into the attenuation comparison of Requirement 30.9.
        assert rms_db(np.zeros(100)) == -math.inf
        assert rms_db(np.array([])) == -math.inf


class TestMeasureReport:
    def test_reports_all_three_quantities(self) -> None:
        report = measure(sine(1_000.0, 0.3))

        assert math.isfinite(report.integrated_loudness_lufs)
        assert math.isfinite(report.true_peak_dbtp)
        assert len(report.octave_band_energies_db) == 10

    def test_reported_form_rounds_only_the_two_headline_numbers(self) -> None:
        # Requirement 30.24 names "두 측정값"; 30.22 asks for the band energies without
        # stating a precision, so they are passed through unchanged.
        report = measure(sine(1_000.0, 0.3))
        reported = report.reported()

        assert reported.integrated_loudness_lufs == round_to_step(report.integrated_loudness_lufs)
        assert reported.true_peak_dbtp == round_to_step(report.true_peak_dbtp)
        assert reported.octave_band_energies_db == report.octave_band_energies_db

    def test_as_dict_is_json_safe(self) -> None:
        import json

        json.dumps(measure(silence()).as_dict())
        assert measure(silence()).as_dict()["integrated_loudness_lufs"] is None
