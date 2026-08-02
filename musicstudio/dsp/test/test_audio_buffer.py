"""The PCM buffer shape, and the places it has to agree with the TypeScript model.

``musicstudio/domain/audio/pcm.ts`` is the other implementation of this shape.
The two are read by the same requirements across the seam described in
``services/sound/measurement.ts``, so the tests that matter most here are the
ones that pin *agreement* rather than plausibility — notably the rounding rule,
where Python and JavaScript disagree by default.
"""

from __future__ import annotations

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import (
    AudioBuffer,
    from_interleaved,
    to_interleaved,
    window_sample_count,
)


class TestShape:
    def test_reports_channel_frame_and_duration(self) -> None:
        audio = AudioBuffer.from_channels(48_000, [np.zeros(24_000), np.zeros(24_000)])

        assert audio.channel_count == 2
        assert audio.frame_count == 24_000
        assert audio.duration_ms == pytest.approx(500.0)

    def test_duration_is_unrounded(self) -> None:
        # 1 frame at 48 kHz is 0.0208...ms. Rounding here would erase the very
        # quantity Requirement 19.5's tolerance is measured in.
        audio = AudioBuffer.from_channels(48_000, [np.zeros(1)])

        assert audio.duration_ms == pytest.approx(1000.0 / 48_000)
        assert audio.duration_ms > 0

    def test_coerces_channels_to_float32(self) -> None:
        audio = AudioBuffer.from_channels(48_000, [[0.5, -0.5], [1, 0]])

        assert all(channel.dtype == np.float32 for channel in audio.channels)

    def test_empty_and_ragged_buffers_are_not_well_formed(self) -> None:
        assert not AudioBuffer.from_channels(48_000, []).is_well_formed
        assert not AudioBuffer.from_channels(48_000, [np.zeros(0)]).is_well_formed
        assert not AudioBuffer(
            sample_rate=48_000,
            channels=(np.zeros(4, np.float32), np.zeros(5, np.float32)),
        ).is_well_formed

    def test_non_positive_sample_rate_is_not_well_formed(self) -> None:
        assert not AudioBuffer.from_channels(0, [np.zeros(4)]).is_well_formed
        assert AudioBuffer.from_channels(0, [np.zeros(4)]).duration_ms == 0.0


class TestWindowSampleCount:
    def test_matches_the_documented_44100_case(self) -> None:
        # The example ``domain/audio/pcm.ts`` states: 441, not 440.
        assert window_sample_count(44_100, 10) == 441

    def test_rounds_halves_upward_like_math_round(self) -> None:
        # Python's built-in round() is banker's rounding and would answer 0 and 2
        # here; JavaScript's Math.round answers 1 and 3. The TypeScript side is
        # the reference, so these are the expected values.
        assert window_sample_count(1_000, 0.5) == 1  # exactly 0.5 samples
        assert window_sample_count(1_000, 2.5) == 3  # exactly 2.5 samples
        assert window_sample_count(1_000, 3.5) == 4

    def test_never_returns_zero(self) -> None:
        assert window_sample_count(48_000, 0) == 1
        assert window_sample_count(48_000, 0.001) == 1


class TestInterleaving:
    def test_round_trips_through_interleaved_form(self) -> None:
        original = AudioBuffer.from_channels(48_000, [[0.1, 0.2, 0.3], [-0.1, -0.2, -0.3]])

        restored = from_interleaved(to_interleaved(original), original.sample_rate)

        assert restored.sample_rate == original.sample_rate
        assert restored.channel_count == 2
        for expected, actual in zip(original.channels, restored.channels):
            np.testing.assert_array_equal(expected, actual)

    def test_reads_a_1d_array_as_mono(self) -> None:
        audio = from_interleaved(np.array([0.1, 0.2, 0.3], dtype=np.float32), 48_000)

        assert audio.channel_count == 1
        assert audio.frame_count == 3

    def test_to_interleaved_is_always_2d(self) -> None:
        mono = AudioBuffer.from_channels(48_000, [[0.1, 0.2]])

        assert to_interleaved(mono).shape == (2, 1)

    def test_refuses_a_ragged_buffer(self) -> None:
        ragged = AudioBuffer(
            sample_rate=48_000,
            channels=(np.zeros(4, np.float32), np.zeros(5, np.float32)),
        )

        with pytest.raises(ValueError, match="unequal lengths"):
            to_interleaved(ragged)

    def test_refuses_more_than_two_dimensions(self) -> None:
        with pytest.raises(ValueError, match="1-D or 2-D"):
            from_interleaved(np.zeros((2, 2, 2), dtype=np.float32), 48_000)
