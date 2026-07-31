"""48 kHz normalisation with ``libsoxr`` VHQ — Requirements 19.4, 19.5, 13.10.

The acceptance criterion of task 3.1 is quantitative: a non-48 kHz input, once
resampled, differs in length from the original by at most 10 ms. That is a
statement over *all* input rates and lengths, not over a handful, so it is tested
with ``hypothesis`` as well as at the boundaries that a generator is unlikely to
reach on its own (8 kHz and 192 kHz, one-frame inputs, non-standard rates).
"""

from __future__ import annotations

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.resample import (
    INTERNAL_SAMPLE_RATE,
    LENGTH_TOLERANCE_MS,
    RESAMPLE_QUALITY,
    LengthToleranceExceededError,
    normalise_sample_rate,
    normalise_sample_rate_strict,
    resample,
)

# Rates an engine or an upload can realistically present, plus two deliberately
# non-standard ones: the tolerance must not depend on the ratio being rational
# with a small denominator.
REALISTIC_RATES = (8_000, 11_025, 16_000, 22_050, 32_000, 44_100, 88_200, 96_000, 192_000)
AWKWARD_RATES = (7_999, 44_101)

#: Requirement 19.11's floor. Nothing shorter is a storable ``Audio_Asset``, so
#: nothing shorter is in this function's domain — and it genuinely is a domain
#: boundary rather than a convenience: one frame at 192 kHz is 0.0052 ms, which
#: downsampling to 48 kHz cannot represent at all (see the guard in
#: ``TestResampleBasics``). Fixing the generator's floor here states the domain
#: instead of letting the property discover it as a failure.
MIN_ASSET_DURATION_MS = 1.0


def frames_for(sample_rate: int, duration_ms: float) -> int:
    """Frame count for a duration, rounded up so the result is never shorter."""
    return max(1, -(-int(sample_rate * duration_ms * 1000) // 1_000_000))


def synth(sample_rate: int, frames: int, channels: int = 2, frequency: float = 440.0) -> AudioBuffer:
    """A deterministic band-limited test signal.

    A sine rather than noise, and synthesised from parameters rather than drawn
    sample-by-sample from ``hypothesis``: a resampler is band-limited, so white
    noise at the Nyquist edge would be attenuated by design and would make an
    amplitude assertion meaningless, while generating a million floats per
    example would make the property slow without testing anything more. The
    quantities under test are *lengths*, and the generator constrains rate and
    frame count, which are what lengths are made of.
    """
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = (0.5 * np.sin(2.0 * np.pi * frequency * t)).astype(np.float32)
    return AudioBuffer.from_channels(sample_rate, [wave * (1.0 - 0.25 * c) for c in range(channels)])


class TestResampleBasics:
    def test_uses_vhq_quality(self) -> None:
        # Design §5.2 fixes the quality setting; it is not a caller's choice.
        assert RESAMPLE_QUALITY == "VHQ"

    def test_internal_rate_is_48khz(self) -> None:
        assert INTERNAL_SAMPLE_RATE == 48_000

    def test_converts_the_sample_rate_and_keeps_the_channel_count(self) -> None:
        source = synth(44_100, 44_100)

        converted = resample(source, INTERNAL_SAMPLE_RATE)

        assert converted.sample_rate == INTERNAL_SAMPLE_RATE
        assert converted.channel_count == 2
        assert converted.frame_count == pytest.approx(48_000, abs=2)

    def test_is_a_true_no_op_at_the_target_rate(self) -> None:
        # An identity pass through a band-limited filter is not lossless, and
        # Requirement 13.3's conversions depend on the no-op case being exact.
        source = synth(48_000, 4_800)

        converted = resample(source, INTERNAL_SAMPLE_RATE)

        assert converted is source

    def test_is_deterministic(self) -> None:
        # Design §5.5: the same input must give the same output, bit for bit.
        source = synth(44_100, 44_100)

        first = resample(source, INTERNAL_SAMPLE_RATE)
        second = resample(source, INTERNAL_SAMPLE_RATE)

        for left, right in zip(first.channels, second.channels):
            np.testing.assert_array_equal(left, right)

    def test_preserves_mono(self) -> None:
        converted = resample(synth(22_050, 22_050, channels=1), INTERNAL_SAMPLE_RATE)

        assert converted.channel_count == 1

    def test_refuses_a_malformed_buffer(self) -> None:
        with pytest.raises(ValueError, match="not well formed"):
            resample(AudioBuffer.from_channels(44_100, []), INTERNAL_SAMPLE_RATE)

    def test_refuses_a_non_positive_target_rate(self) -> None:
        with pytest.raises(ValueError, match="must be positive"):
            resample(synth(44_100, 100), 0)

    def test_refuses_a_ratio_that_would_empty_the_buffer(self) -> None:
        # One frame at 44.1 kHz is shorter than one output sample at 3 Hz, so the
        # resampler returns nothing. An empty buffer is not well formed, and
        # passing one on would surface the fault far from its cause.
        with pytest.raises(ValueError, match="yields no samples"):
            resample(synth(44_100, 1), 3)


class TestReport:
    def test_records_the_original_rate_for_provenance(self) -> None:
        # Requirement 19.5 requires the original rate in the provenance record,
        # so it has to leave this function as a value.
        report = normalise_sample_rate(synth(44_100, 44_100))

        assert report.original_sample_rate == 44_100
        assert report.audio.sample_rate == INTERNAL_SAMPLE_RATE
        assert report.resampled is True

    def test_marks_already_48khz_input_as_not_resampled(self) -> None:
        # Requirement 19.5's clause only fires for audio that was not 48 kHz.
        report = normalise_sample_rate(synth(48_000, 48_000))

        assert report.resampled is False
        assert report.length_error_ms == 0.0

    def test_reports_the_length_error_without_raising(self) -> None:
        report = normalise_sample_rate(synth(44_100, 44_100))

        assert abs(report.length_error_ms) <= LENGTH_TOLERANCE_MS
        assert report.within_tolerance is True

    def test_strict_variant_raises_beyond_the_tolerance(self) -> None:
        # The tolerance is a precondition of storing, so the storing path refuses
        # rather than records. Reaching a breach at all takes a target rate where
        # a single output sample spans more than 10 ms — below 100 Hz — which is
        # itself the reason the ±10 ms bound is met so comfortably at 48 kHz:
        # the error is bounded by one output sample period, 0.0208 ms.
        with pytest.raises(LengthToleranceExceededError) as caught:
            normalise_sample_rate_strict(synth(44_100, 66_150), target_sample_rate=3)

        assert caught.value.tolerance_ms == LENGTH_TOLERANCE_MS
        assert abs(caught.value.error_ms) > LENGTH_TOLERANCE_MS

    def test_strict_variant_returns_the_report_when_within_tolerance(self) -> None:
        report = normalise_sample_rate_strict(synth(96_000, 96_000))

        assert report.audio.sample_rate == INTERNAL_SAMPLE_RATE


class TestLengthTolerance:
    """The task 3.1 acceptance criterion: length error ≤ ±10 ms after resampling."""

    @pytest.mark.parametrize("sample_rate", REALISTIC_RATES + AWKWARD_RATES)
    @pytest.mark.parametrize("duration_ms", [MIN_ASSET_DURATION_MS, 2, 17, 100])
    def test_holds_at_the_boundaries_a_generator_rarely_reaches(
        self, sample_rate: int, duration_ms: float
    ) -> None:
        report = normalise_sample_rate(synth(sample_rate, frames_for(sample_rate, duration_ms)))

        assert abs(report.length_error_ms) <= LENGTH_TOLERANCE_MS

    @pytest.mark.parametrize("sample_rate", [8_000, 44_100, 192_000])
    def test_holds_for_multi_minute_audio(self, sample_rate: int) -> None:
        # Requirement 19.11 allows up to 3 600 000 ms. A fixed absolute tolerance
        # is the harder claim the longer the audio, so a long case is checked
        # explicitly rather than left to the generator's shorter examples.
        report = normalise_sample_rate(synth(sample_rate, sample_rate * 120))

        assert abs(report.length_error_ms) <= LENGTH_TOLERANCE_MS

    # ------------------------------------------------------------------ property
    #
    # Unnumbered property. Design §10 numbers Correctness Properties 1 to 24 and
    # `tasks.md` §9.2's ownership table assigns none of them to task 3.1, so this
    # is *not* one of the twenty-four and the §9.2 coverage audit must not count
    # it as one. It is written as a property regardless, because Requirement 19.5
    # states a quantitative invariant over every input rate and length rather
    # than over a list of examples.
    #
    # Property under test: for any source sample rate and any frame count,
    # normalising to 48 kHz changes the duration by at most ±10 ms.
    #
    # Validates: Requirements 19.4, 19.5
    @given(
        sample_rate=st.one_of(
            st.sampled_from(REALISTIC_RATES + AWKWARD_RATES),
            st.integers(min_value=4_000, max_value=192_000),
        ),
        duration_ms=st.floats(
            min_value=MIN_ASSET_DURATION_MS, max_value=500.0, allow_nan=False
        ),
        channels=st.integers(min_value=1, max_value=2),
        frequency=st.floats(min_value=20.0, max_value=1_000.0, allow_nan=False),
    )
    @settings(max_examples=100, deadline=None)
    def test_resampling_to_48khz_preserves_length_within_10ms(
        self, sample_rate: int, duration_ms: float, channels: int, frequency: float
    ) -> None:
        source = synth(
            sample_rate,
            frames_for(sample_rate, duration_ms),
            channels=channels,
            frequency=frequency,
        )

        report = normalise_sample_rate(source)

        assert report.audio.sample_rate == INTERNAL_SAMPLE_RATE
        assert report.audio.channel_count == channels
        assert report.original_sample_rate == sample_rate
        assert abs(report.length_error_ms) <= LENGTH_TOLERANCE_MS
        assert report.within_tolerance is True
