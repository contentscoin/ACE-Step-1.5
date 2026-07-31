"""Loudness normalisation, dialogue cleanup and ducking (Requirements 30.6–30.18).

**This file owns Property 15** (design §10), the loudness-normalisation idempotence
property, and it owns the two quantitative acceptance criteria of task 3.3:

* the ±0.1 dB idempotence bound — ``TestProperty15``, as a real **re-application** of the
  normaliser to its own output, not a re-measurement of the first result;
* the ±1.0 LUFS speech-loudness bound after dialogue cleanup — ``TestSpeechLoudnessBound``.

Both are property tests over generated audio rather than example tests over one fixture,
because both are claims about *all* admissible inputs. The generators are deliberately
narrow-but-adversarial: real-ish signals (tone stacks, noise bursts, speech-like envelopes)
at levels that reach both the true-peak ceiling and the −70 LUFS gate, rather than uniform
random samples that would be neither music nor speech.

Requirement 30.18's determinism is asserted directly, in ``TestDeterminism``, for the same
reason ``test_effects.py`` does it for Requirement 29.29: the claim is bit-exactness, and
bit-exactness is the kind of thing that stops being true silently.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.loudness import (
    integrated_loudness_lufs,
    registry,
    rms_db,
    true_peak_dbtp,
)
from musicstudio_dsp.mastering import (
    apply_gain_db,
    clean_dialogue,
    detect_speech_regions,
    duck,
    ducking_envelope,
    normalise_loudness,
    speech_loudness_lufs,
    SpeechRegion,
)

SAMPLE_RATE = 48_000
REGISTRY = registry()
TARGET_TOLERANCE_LUFS = REGISTRY.threshold("loudness_normalization_target_tolerance_lufs")
IDEMPOTENCE_GAIN_DB = REGISTRY.threshold("loudness_normalization_idempotence_gain_db")
ATTENUATION_MIN_DB = REGISTRY.threshold("dialogue_cleanup_non_speech_attenuation_min_db")
SPEECH_LOUDNESS_TOLERANCE_LUFS = REGISTRY.threshold(
    "dialogue_cleanup_speech_loudness_tolerance_lufs"
)
LENGTH_TOLERANCE_MS = REGISTRY.threshold("dialogue_cleanup_length_tolerance_ms")
DEPTH_ACCURACY_DB = REGISTRY.threshold("ducking_depth_accuracy_db")
NON_SPEECH_HOLD_DB = REGISTRY.threshold("ducking_non_speech_hold_db")
TRUE_PEAK_CEILING_DBTP = REGISTRY.true_peak_ceiling_dbtp


# --------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------

def tone_stack(
    seed: int, amplitude: float, seconds: float = 1.0, channels: int = 1
) -> AudioBuffer:
    """A deterministic sum of a few partials plus a little noise, scaled to ``amplitude``.

    A tone stack rather than white noise: white noise has a nearly flat spectrum and a
    crest factor that barely varies, so it exercises neither the K-weighting nor the
    true-peak path. A handful of partials at unrelated frequencies produces a peak-to-loudness
    ratio that moves with the seed, which is what makes the ceiling actually bind for some
    inputs and not others.
    """
    rng = np.random.default_rng(seed)
    frames = int(round(SAMPLE_RATE * seconds))
    t = np.arange(frames, dtype=np.float64) / SAMPLE_RATE
    wave = np.zeros(frames, dtype=np.float64)
    for _ in range(4):
        frequency = float(rng.uniform(60.0, 6_000.0))
        phase = float(rng.uniform(0.0, 2.0 * math.pi))
        wave += rng.uniform(0.3, 1.0) * np.sin(2.0 * math.pi * frequency * t + phase)
    wave += 0.05 * rng.standard_normal(frames)

    peak = float(np.max(np.abs(wave)))
    if peak > 0:
        wave = wave / peak * amplitude
    signal = wave.astype(np.float32)
    return AudioBuffer.from_channels(SAMPLE_RATE, [signal] * channels)


def speech_like(
    seed: int,
    *,
    speech_amplitude: float = 0.3,
    floor_amplitude: float = 0.002,
    seconds: float = 3.0,
    channels: int = 1,
) -> tuple[AudioBuffer, tuple[tuple[float, float], ...]]:
    """A quiet floor with two or three loud, speech-length bursts in it.

    Returns the audio and the intervals the bursts were placed at, so a test can compare
    what :func:`detect_speech_regions` found against what was put there rather than
    against what it found last time.

    The floor is well below the −45 dB gate and the bursts well above it, so the detector's
    verdict is a property of the signal rather than of where the threshold happens to sit.
    Burst lengths are all comfortably over the 200 ms minimum: this generator exercises the
    *cleanup* rules, and a burst straddling the minimum-duration boundary would make the
    region set depend on window alignment, which ``TestSpeechDetection`` tests directly
    instead.
    """
    rng = np.random.default_rng(seed)
    frames = int(round(SAMPLE_RATE * seconds))
    t = np.arange(frames, dtype=np.float64) / SAMPLE_RATE
    signal = (floor_amplitude * rng.standard_normal(frames)).astype(np.float32)

    intervals: list[tuple[float, float]] = []
    cursor = 0.4
    while cursor + 0.9 < seconds - 0.2:
        length = float(rng.uniform(0.4, 0.8))
        start, stop = cursor, cursor + length
        mask = (t >= start) & (t < stop)
        frequency = float(rng.uniform(180.0, 400.0))
        signal[mask] += (
            speech_amplitude * np.sin(2.0 * math.pi * frequency * t[mask])
        ).astype(np.float32)
        intervals.append((start * 1000.0, stop * 1000.0))
        cursor = stop + float(rng.uniform(0.35, 0.7))

    return (
        AudioBuffer.from_channels(SAMPLE_RATE, [signal] * channels),
        tuple(intervals),
    )


# --------------------------------------------------------------------------------------
# Property 15
# --------------------------------------------------------------------------------------

class TestProperty15:
    """Feature: ai-music-generation-service, Property 15: 라우드니스 정규화 멱등.

    *For any* audio whose integrated loudness is within ±0.5 LUFS of the target, applying
    the loudness normalisation again with the same target changes the applied gain by
    ≤ 0.1 dB, the integrated loudness by ≤ ±0.1 LUFS and the true peak by ≤ ±0.1 dB.

    **Validates: Requirements 30.8**

    ### Why this is a re-application and not a re-measurement

    The claim in Requirement 30.8 is about what happens when normalisation *runs twice*.
    So the test runs it twice: once to reach the target, and then again **on the first
    run's output**, and asserts the second run's own applied gain is ≈ 0. A test that
    measured the first output twice would pass for a normaliser that was not idempotent at
    all — it would only be testing that the meter is a function.

    ### Why the precondition is established rather than assumed

    Requirement 30.8 is conditioned on the audio already being within ±0.5 LUFS of the
    target. Generating audio that happens to satisfy that would reject almost every
    example, so instead each case *normalises first* and then asserts the property on the
    result — checking the precondition holds before making the claim, and skipping the
    handful of cases where the true-peak ceiling prevented the first run from reaching the
    band at all. Those cases are not vacuous omissions: they are Requirement 30.25's
    territory, and ``TestTruePeakPriority`` covers them.

    ### What "적용 게인 변화량" means

    Requirement 30.8 bounds "적용 게인 변화량" — the amount of gain the *re-application*
    applies. That is the second run's own gain, not the difference between the two runs'
    gains: the first run legitimately applies whatever the audio needed (−17 dB, say), and
    a bound on `|second − first|` would be a claim that the second run applies almost as
    much gain as the first, which is the opposite of idempotence. The quantity that must be
    near zero is the second run's gain, because that is the change the re-application makes
    to audio that was already at target.
    """

    @settings(max_examples=120, deadline=None)
    @given(
        seed=st.integers(min_value=0, max_value=10_000),
        amplitude=st.floats(min_value=0.05, max_value=0.95),
        target_lufs=st.sampled_from([-30.0, -23.0, -18.0, -16.0, -14.0, -11.0, -8.0, -6.0]),
        channels=st.integers(min_value=1, max_value=2),
    )
    def test_reapplication_changes_the_applied_gain_by_at_most_0_1_db(
        self, seed: int, amplitude: float, target_lufs: float, channels: int
    ) -> None:
        audio = tone_stack(seed, amplitude, channels=channels)

        first = normalise_loudness(audio, target_lufs)
        if not first.measurable:
            return
        # Requirement 30.8's precondition: the property is claimed of audio already inside
        # the ±0.5 LUFS band. When the true-peak ceiling stopped the first run reaching it,
        # 30.25 applies instead of 30.8.
        if first.target_missed:
            return
        assert (
            abs(first.after.integrated_loudness_lufs - target_lufs) <= TARGET_TOLERANCE_LUFS
        )

        # The re-application. This is the whole point of the property.
        second = normalise_loudness(first.audio, target_lufs)

        assert abs(second.applied_gain_db) <= IDEMPOTENCE_GAIN_DB, (
            f"re-application applied {second.applied_gain_db:.6f} dB"
        )
        assert (
            abs(
                second.after.integrated_loudness_lufs - first.after.integrated_loudness_lufs
            )
            <= 0.1
        )
        assert abs(second.after.true_peak_dbtp - first.after.true_peak_dbtp) <= 0.1

    @settings(max_examples=100, deadline=None)
    @given(
        seed=st.integers(min_value=0, max_value=10_000),
        amplitude=st.floats(min_value=0.05, max_value=0.95),
        target_lufs=st.sampled_from([-24.0, -16.0, -14.0, -9.0]),
    )
    def test_a_third_application_moves_nothing_either(
        self, seed: int, amplitude: float, target_lufs: float
    ) -> None:
        # Idempotence is a fixed-point claim, so it has to survive iteration: a normaliser
        # that alternated between two values would satisfy a single re-application and fail
        # here.
        audio = tone_stack(seed, amplitude)
        first = normalise_loudness(audio, target_lufs)
        if not first.measurable or first.target_missed:
            return

        second = normalise_loudness(first.audio, target_lufs)
        third = normalise_loudness(second.audio, target_lufs)

        assert abs(third.applied_gain_db) <= IDEMPOTENCE_GAIN_DB
        assert abs(second.applied_gain_db) <= IDEMPOTENCE_GAIN_DB
        assert (
            abs(third.after.integrated_loudness_lufs - first.after.integrated_loudness_lufs)
            <= 0.1
        )


# --------------------------------------------------------------------------------------
# Normalisation (Requirements 30.6, 30.7, 30.25)
# --------------------------------------------------------------------------------------

class TestNormalisation:
    def test_reaches_the_target_when_headroom_allows(self) -> None:
        # Requirement 30.6's ±0.5 LUFS.
        audio = tone_stack(1, 0.2)

        result = normalise_loudness(audio, -20.0)

        assert result.measurable is True
        assert abs(result.after.integrated_loudness_lufs - (-20.0)) <= TARGET_TOLERANCE_LUFS
        assert result.target_missed is False

    def test_defaults_the_target_to_minus_14_lufs(self) -> None:
        # Requirement 30.5's default, resolved from the shared registry.
        result = normalise_loudness(tone_stack(2, 0.2))

        assert result.target_lufs == -14.0

    def test_refuses_to_touch_audio_with_no_measurable_loudness(self) -> None:
        # Requirement 30.6's precondition. Applying 60 dB of gain to a noise floor is the
        # behaviour the −70 LUFS gate exists to prevent.
        silence = AudioBuffer.from_channels(
            SAMPLE_RATE, [np.zeros(SAMPLE_RATE, dtype=np.float32)]
        )

        result = normalise_loudness(silence, -14.0)

        assert result.measurable is False
        assert result.applied_gain_db == 0.0
        assert np.array_equal(result.audio.channels[0], silence.channels[0])

    def test_is_a_pure_gain_so_the_waveform_shape_is_unchanged(self) -> None:
        # The property the idempotence argument rests on, stated directly: normalisation
        # scales, it does not compress. A limiter would sound better and would not be
        # idempotent — see the module docstring in `mastering.py`.
        audio = tone_stack(3, 0.3)
        result = normalise_loudness(audio, -18.0)

        factor = 10.0 ** (result.applied_gain_db / 20.0)
        expected = (audio.channels[0].astype(np.float64) * factor).astype(np.float32)

        assert np.allclose(result.audio.channels[0], expected, atol=1e-6)

    def test_preserves_length_and_channel_count(self) -> None:
        audio = tone_stack(4, 0.3, channels=2)
        result = normalise_loudness(audio, -16.0)

        assert result.audio.frame_count == audio.frame_count
        assert result.audio.channel_count == 2


class TestTruePeakPriority:
    """Requirement 30.7: the ceiling wins, and Requirement 30.25 reports the shortfall."""

    def test_never_exceeds_the_ceiling_even_when_the_target_demands_it(self) -> None:
        # A loud, low-crest-factor signal asked to go much louder: the target needs positive
        # gain the ceiling cannot give.
        audio = tone_stack(5, 0.95)

        result = normalise_loudness(audio, -6.0)

        assert result.after.true_peak_dbtp <= TRUE_PEAK_CEILING_DBTP + 1e-6
        assert result.true_peak_limited is True

    def test_reports_the_shortfall_rather_than_hiding_it(self) -> None:
        # Requirement 30.25: the achieved loudness, the shortfall and the missed flag.
        audio = tone_stack(6, 0.95)

        result = normalise_loudness(audio, -6.0)

        assert result.target_missed is True
        assert result.shortfall_lufs > 0
        assert result.shortfall_lufs == pytest.approx(
            -6.0 - result.after.integrated_loudness_lufs, abs=1e-9
        )

    def test_applies_the_smaller_of_the_two_gains(self) -> None:
        audio = tone_stack(7, 0.9)
        result = normalise_loudness(audio, -6.0)

        assert result.applied_gain_db < result.requested_gain_db
        assert result.applied_gain_db == pytest.approx(
            TRUE_PEAK_CEILING_DBTP - result.before.true_peak_dbtp, abs=1e-9
        )

    @settings(max_examples=100, deadline=None)
    @given(
        seed=st.integers(min_value=0, max_value=5_000),
        amplitude=st.floats(min_value=0.05, max_value=0.999),
        target_lufs=st.sampled_from([-30.0, -20.0, -14.0, -8.0, -6.0]),
    )
    def test_the_ceiling_is_an_invariant_of_every_result(
        self, seed: int, amplitude: float, target_lufs: float
    ) -> None:
        # Requirement 30.7 is stated as an invariant ("불변식"), so it is tested as one
        # rather than only on the examples where the ceiling was expected to bind.
        #
        # An unnumbered property test: design §10 numbers Properties 1–24 and this is not
        # one of them, so it is labelled here to keep task 9.2's audit from miscounting it.
        result = normalise_loudness(tone_stack(seed, amplitude), target_lufs)
        if not result.measurable:
            return

        assert result.after.true_peak_dbtp <= TRUE_PEAK_CEILING_DBTP + 1e-6


# --------------------------------------------------------------------------------------
# Speech detection (Requirement 30.12)
# --------------------------------------------------------------------------------------

class TestSpeechDetection:
    def test_finds_the_bursts_that_were_put_there(self) -> None:
        audio, intervals = speech_like(11)

        regions = detect_speech_regions(audio)

        assert len(regions) == len(intervals)
        for region, (start_ms, stop_ms) in zip(regions, intervals):
            # Within one 100 ms analysis window of the truth, which is the resolution
            # Requirement 30.12's window fixes.
            assert abs(region.start_ms - start_ms) <= REGISTRY.speech_window_ms
            assert abs(region.end_ms - stop_ms) <= REGISTRY.speech_window_ms

    def test_ignores_a_burst_shorter_than_the_minimum_duration(self) -> None:
        # Requirement 30.12's "200밀리초 이상 연속 구간": a 100 ms burst is loud but is not
        # a speech region.
        frames = SAMPLE_RATE
        t = np.arange(frames, dtype=np.float64) / SAMPLE_RATE
        signal = np.zeros(frames, dtype=np.float32)
        burst = (t >= 0.4) & (t < 0.5)
        signal[burst] = (0.4 * np.sin(2.0 * math.pi * 300.0 * t[burst])).astype(np.float32)
        audio = AudioBuffer.from_channels(SAMPLE_RATE, [signal])

        assert detect_speech_regions(audio) == ()

    def test_uses_an_inclusive_comparison_against_the_threshold(self) -> None:
        # "이상" is inclusive. A window sitting exactly at the threshold is speech.
        threshold_db = REGISTRY.threshold("speech_detection_rms_threshold_db")
        amplitude = 10.0 ** (threshold_db / 20.0) * math.sqrt(2.0)
        frames = SAMPLE_RATE
        t = np.arange(frames, dtype=np.float64) / SAMPLE_RATE
        signal = (amplitude * np.sin(2.0 * math.pi * 300.0 * t)).astype(np.float32)
        audio = AudioBuffer.from_channels(SAMPLE_RATE, [signal])

        regions = detect_speech_regions(audio)

        assert len(regions) == 1
        assert rms_db(signal) == pytest.approx(threshold_db, abs=0.05)

    def test_silence_holds_no_speech(self) -> None:
        silence = AudioBuffer.from_channels(
            SAMPLE_RATE, [np.zeros(SAMPLE_RATE, dtype=np.float32)]
        )

        assert detect_speech_regions(silence) == ()

    def test_a_wholly_loud_buffer_is_one_region_covering_it(self) -> None:
        audio = tone_stack(12, 0.3, seconds=1.0)

        regions = detect_speech_regions(audio)

        assert len(regions) == 1
        assert regions[0].start_ms == 0.0
        assert regions[0].end_ms == pytest.approx(audio.duration_ms, abs=1e-9)


# --------------------------------------------------------------------------------------
# Dialogue cleanup (Requirements 30.9, 30.10)
# --------------------------------------------------------------------------------------

class TestSpeechLoudnessBound:
    """Task 3.3's second acceptance criterion, as a property.

    "대사 정리 후 발화 구간 라우드니스 ±1.0LUFS" — Requirement 30.9's second half. The
    bound is read from the Quality_Threshold_Set rather than written as 1.0 here, so the
    test and the requirement cannot drift apart.

    An unnumbered property test: design §10's Properties 1–24 do not include this one, and
    it is labelled so task 9.2's audit does not miscount it as a numbered Property.

    **Validates: Requirements 30.9**
    """

    @settings(max_examples=100, deadline=None)
    @given(
        seed=st.integers(min_value=0, max_value=5_000),
        speech_amplitude=st.floats(min_value=0.05, max_value=0.7),
        floor_amplitude=st.floats(min_value=0.0002, max_value=0.004),
        channels=st.integers(min_value=1, max_value=2),
    )
    def test_speech_loudness_moves_by_at_most_one_lufs(
        self, seed: int, speech_amplitude: float, floor_amplitude: float, channels: int
    ) -> None:
        audio, _ = speech_like(
            seed,
            speech_amplitude=speech_amplitude,
            floor_amplitude=floor_amplitude,
            channels=channels,
        )

        result = clean_dialogue(audio)
        if not result.speech_regions:
            return
        # The comparison is only meaningful when both measurements exist.
        if not math.isfinite(result.speech_loudness_before_lufs):
            return

        assert abs(result.speech_loudness_delta_lufs) <= SPEECH_LOUDNESS_TOLERANCE_LUFS, (
            f"speech loudness moved {result.speech_loudness_delta_lufs:.4f} LUFS"
        )

    @settings(max_examples=100, deadline=None)
    @given(
        seed=st.integers(min_value=0, max_value=5_000),
        speech_amplitude=st.floats(min_value=0.05, max_value=0.7),
        floor_amplitude=st.floats(min_value=0.0002, max_value=0.004),
    )
    def test_non_speech_comes_down_by_at_least_the_required_attenuation(
        self, seed: int, speech_amplitude: float, floor_amplitude: float
    ) -> None:
        # Requirement 30.9's first half, and the reason `_solve_floor_db` exists: with the
        # floor set naively to −10 dB the measured reduction lands near 9.2 dB, because the
        # transition ramps are non-speech frames that are only partly attenuated.
        #
        # An unnumbered property test, as above.
        audio, _ = speech_like(
            seed, speech_amplitude=speech_amplitude, floor_amplitude=floor_amplitude
        )

        result = clean_dialogue(audio)
        if not result.has_non_speech or not math.isfinite(result.non_speech_rms_before_db):
            return

        assert result.non_speech_attenuation_db >= ATTENUATION_MIN_DB - 1e-9, (
            f"non-speech came down only {result.non_speech_attenuation_db:.4f} dB"
        )

    @settings(max_examples=100, deadline=None)
    @given(seed=st.integers(min_value=0, max_value=5_000))
    def test_length_is_preserved_exactly(self, seed: int) -> None:
        # Requirement 30.10 allows ±10 ms; an envelope multiply gives 0 ms, because no
        # sample is added or removed. Asserted at 0 rather than at the tolerance so a future
        # change to a cut-based implementation fails here rather than passing marginally.
        #
        # An unnumbered property test, as above.
        audio, _ = speech_like(seed)

        result = clean_dialogue(audio)

        assert result.length_error_ms == 0.0
        assert result.length_error_ms <= LENGTH_TOLERANCE_MS
        assert result.audio.frame_count == audio.frame_count


class TestDialogueCleanup:
    def test_leaves_the_interior_of_every_speech_region_untouched(self) -> None:
        # The ramps sit *inside* each region — see `_cleanup_shape` on why the obvious
        # arrangement makes Requirement 30.9's first half unsatisfiable — so the first and
        # last 20 ms of a region are attenuated and everything between them is byte-identical.
        transition_frames = int(round(0.020 * SAMPLE_RATE))
        audio, _ = speech_like(21)
        result = clean_dialogue(audio)

        assert result.speech_regions
        for region in result.speech_regions:
            start = int(round(region.start_ms * SAMPLE_RATE / 1000.0)) + transition_frames
            stop = int(round(region.end_ms * SAMPLE_RATE / 1000.0)) - transition_frames
            assert stop > start
            assert np.array_equal(
                audio.channels[0][start:stop], result.audio.channels[0][start:stop]
            )

    def test_attenuates_every_non_speech_frame_by_the_full_floor(self) -> None:
        # The consequence of ramping inside the regions, and the reason the achieved
        # attenuation can never saturate: there is no partly-attenuated non-speech frame.
        audio, _ = speech_like(24)
        result = clean_dialogue(audio)
        expected_factor = 10.0 ** (result.applied_floor_db / 20.0)

        mask = np.zeros(audio.frame_count, dtype=bool)
        for region in result.speech_regions:
            start = int(round(region.start_ms * SAMPLE_RATE / 1000.0))
            stop = int(round(region.end_ms * SAMPLE_RATE / 1000.0))
            mask[start:stop] = True

        assert np.allclose(
            result.audio.channels[0][~mask],
            audio.channels[0][~mask].astype(np.float64) * expected_factor,
            atol=1e-7,
        )

    def test_honours_a_larger_requested_attenuation(self) -> None:
        audio, _ = speech_like(22)

        result = clean_dialogue(audio, attenuation_db=24.0)

        assert result.non_speech_attenuation_db >= 24.0 - 1e-9

    def test_reports_no_non_speech_for_audio_that_is_speech_end_to_end(self) -> None:
        # Requirement 30.9's first clause is vacuous here, and the flag is what tells the
        # product layer so — rather than it having to infer it from two −inf levels whose
        # difference is NaN.
        audio = tone_stack(23, 0.3, seconds=1.0)

        result = clean_dialogue(audio)

        assert result.has_non_speech is False
        assert result.non_speech_rms_before_db == -math.inf

    def test_speech_loudness_is_negative_infinity_when_there_is_no_speech(self) -> None:
        silence = AudioBuffer.from_channels(
            SAMPLE_RATE, [np.zeros(SAMPLE_RATE, dtype=np.float32)]
        )

        assert speech_loudness_lufs(silence, ()) == -math.inf
        assert clean_dialogue(silence).speech_loudness_before_lufs == -math.inf


# --------------------------------------------------------------------------------------
# Ducking (Requirements 30.12–30.17)
# --------------------------------------------------------------------------------------

class TestDuckingEnvelope:
    def test_holds_the_full_depth_across_every_speech_region(self) -> None:
        # Requirement 30.12's ±1.0 dB, checked on the curve rather than on the audio,
        # because the curve is what Requirement 30.17 stores and what the product layer
        # verifies.
        regions = (SpeechRegion(500.0, 1_500.0), SpeechRegion(2_000.0, 2_800.0))
        points = ducking_envelope(regions, 3_000.0, -12.0, 50.0, 300.0)

        for region in regions:
            for time_ms in np.arange(region.start_ms, region.end_ms, 10.0):
                gain = np.interp(
                    time_ms,
                    [t for t, _ in points],
                    [g for _, g in points],
                )
                assert abs(gain - (-12.0)) <= DEPTH_ACCURACY_DB

    def test_reaches_full_depth_by_the_start_of_the_region_not_after_it(self) -> None:
        # The look-ahead. An attack that began at the region start would leave the first
        # 50 ms of every line under-ducked, breaching Requirement 30.12.
        regions = (SpeechRegion(500.0, 1_500.0),)
        points = ducking_envelope(regions, 2_000.0, -12.0, 50.0, 300.0)
        times = [t for t, _ in points]
        gains = [g for _, g in points]

        assert np.interp(500.0, times, gains) == pytest.approx(-12.0, abs=1e-9)
        assert np.interp(450.0, times, gains) == pytest.approx(0.0, abs=1e-9)

    def test_holds_the_bed_at_unity_outside_the_transition_ramps(self) -> None:
        # Requirement 30.16, on the steady-state reading `domain/mastering/ducking.ts`
        # documents: the ramps are exempt because 30.14/30.15 mandate them.
        regions = (SpeechRegion(1_000.0, 1_500.0),)
        attack_ms, release_ms = 50.0, 300.0
        points = ducking_envelope(regions, 3_000.0, -12.0, attack_ms, release_ms)
        times = [t for t, _ in points]
        gains = [g for _, g in points]

        for time_ms in np.arange(0.0, 3_000.0, 10.0):
            in_ramp = (
                1_000.0 - attack_ms <= time_ms <= 1_500.0 + release_ms
            )
            if in_ramp:
                continue
            assert abs(float(np.interp(time_ms, times, gains))) <= NON_SPEECH_HOLD_DB

    def test_takes_the_deeper_gain_where_two_envelopes_overlap(self) -> None:
        # Two lines closer together than attack + release must not lift between them.
        regions = (SpeechRegion(1_000.0, 1_200.0), SpeechRegion(1_300.0, 1_500.0))
        points = ducking_envelope(regions, 2_000.0, -12.0, 50.0, 300.0)
        times = [t for t, _ in points]
        gains = [g for _, g in points]

        # At 1250 ms the first region's release and the second's attack overlap; the deeper
        # of the two is the second's attack, which by then is most of the way down.
        assert float(np.interp(1_250.0, times, gains)) < -6.0

    def test_no_speech_means_a_flat_unity_curve(self) -> None:
        assert ducking_envelope((), 2_000.0, -12.0, 50.0, 300.0) == (
            (0.0, 0.0),
            (2_000.0, 0.0),
        )

    def test_produces_a_curve_a_user_could_edit(self) -> None:
        # Requirement 30.17. A breakpoint per millisecond would be 240 000 points for a
        # four-minute track, which is not something anyone can edit; collinear samples carry
        # no information and are dropped.
        regions = (SpeechRegion(500.0, 1_500.0),)
        points = ducking_envelope(regions, 60_000.0, -12.0, 50.0, 300.0)

        assert len(points) <= 12


class TestDucking:
    def test_attenuates_the_music_and_never_the_dialogue(self) -> None:
        dialogue, _ = speech_like(31)
        music = tone_stack(32, 0.3, seconds=3.0)

        result = duck(dialogue, music, depth_db=-12.0)

        assert result.audio.frame_count == music.frame_count
        # Inside a speech region the music is quieter; the dialogue buffer is untouched
        # because it is never returned and never written.
        region = result.speech_regions[0]
        start = int(round(region.start_ms * SAMPLE_RATE / 1000.0)) + 4_800
        stop = start + 4_800
        assert rms_db(result.audio.channels[0][start:stop]) < rms_db(
            music.channels[0][start:stop]
        ) - 6.0

    def test_leaves_the_music_alone_where_there_is_no_speech(self) -> None:
        dialogue = AudioBuffer.from_channels(
            SAMPLE_RATE, [np.zeros(SAMPLE_RATE * 3, dtype=np.float32)]
        )
        music = tone_stack(33, 0.3, seconds=3.0)

        result = duck(dialogue, music, depth_db=-12.0)

        assert result.speech_regions == ()
        assert np.allclose(result.audio.channels[0], music.channels[0], atol=1e-7)

    def test_defaults_come_from_the_shared_registry(self) -> None:
        # Requirements 30.13, 30.14, 30.15's defaults, resolved by the worker rather than
        # written twice.
        assert REGISTRY.ducking_depth_default_db == -12
        assert REGISTRY.ducking_attack_default_ms == 50
        assert REGISTRY.ducking_release_default_ms == 300

    def test_the_curve_returned_is_the_curve_applied(self) -> None:
        # Requirement 30.17's artefact must describe the audio, or the product layer would
        # be verifying one thing and the user hearing another.
        dialogue, _ = speech_like(34)
        music = tone_stack(35, 0.4, seconds=3.0)

        result = duck(dialogue, music, depth_db=-9.0, attack_ms=40.0, release_ms=250.0)

        times = [t for t, _ in result.automation_points]
        gains = [g for _, g in result.automation_points]
        for frame in range(0, music.frame_count, 4_800):
            time_ms = frame * 1000.0 / SAMPLE_RATE
            expected_factor = 10.0 ** (float(np.interp(time_ms, times, gains)) / 20.0)
            assert result.audio.channels[0][frame] == pytest.approx(
                music.channels[0][frame] * expected_factor, abs=2e-6
            )


# --------------------------------------------------------------------------------------
# Requirement 30.18
# --------------------------------------------------------------------------------------

class TestDeterminism:
    """Requirement 30.18: same input, same parameters, sample-identical output.

    Asserted directly rather than argued in a comment, and under whatever thread count the
    test process happens to have — the same stance ``test_effects.py`` takes on Requirement
    29.29, and for the same reason: the arithmetic here is elementwise, so no BLAS backend
    reassociates it, and the property is thread-count independent by construction.
    """

    def test_normalisation_is_sample_identical_across_runs(self) -> None:
        audio = tone_stack(41, 0.3, channels=2)

        first = normalise_loudness(audio, -16.0)
        second = normalise_loudness(audio, -16.0)

        assert first.applied_gain_db == second.applied_gain_db
        for left, right in zip(first.audio.channels, second.audio.channels):
            assert np.array_equal(left, right)

    def test_cleanup_is_sample_identical_across_runs(self) -> None:
        audio, _ = speech_like(42, channels=2)

        first = clean_dialogue(audio)
        second = clean_dialogue(audio)

        assert first.applied_floor_db == second.applied_floor_db
        assert first.speech_regions == second.speech_regions
        for left, right in zip(first.audio.channels, second.audio.channels):
            assert np.array_equal(left, right)

    def test_ducking_is_sample_identical_across_runs(self) -> None:
        dialogue, _ = speech_like(43)
        music = tone_stack(44, 0.3, seconds=3.0)

        first = duck(dialogue, music)
        second = duck(dialogue, music)

        assert first.automation_points == second.automation_points
        for left, right in zip(first.audio.channels, second.audio.channels):
            assert np.array_equal(left, right)

    def test_apply_gain_of_zero_db_returns_the_input_unchanged(self) -> None:
        # Not an optimisation detail: a 0 dB multiply in float32 is not exactly the identity
        # for every sample, and Requirement 30.8's re-application computes a gain of
        # essentially 0 dB. Short-circuiting keeps the second application bit-exact.
        audio = tone_stack(45, 0.3)

        assert apply_gain_db(audio, 0.0) is audio
