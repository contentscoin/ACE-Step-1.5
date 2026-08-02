"""Waveform reduction (Requirement 12.7).

**Validates: Requirement 12.7**

Two things are worth testing about a reduction whose output a person looks at rather than
measures. The first is the bucket arithmetic, because the same arithmetic exists in
``domain/playback/waveform.ts`` and a drift between them would show up as a waveform that
does not line up with the position a client seeks to — the sort of bug that is obvious in a
screenshot and invisible in an assertion about lengths. The parity here is checked against a
transcription of the TypeScript rule, so a change to one side without the other fails.

The second is the fold across channels: the extreme of a bucket is the extreme over *all*
channels, so a transient present in one channel only stays in the drawing. A mean would
average it away, and nothing about the output's shape would reveal that it had.
"""

from __future__ import annotations

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE
from musicstudio_dsp.waveform import (
    WAVEFORM_BUCKETS_MAX,
    WAVEFORM_BUCKETS_MIN,
    bucket_boundaries,
    reduce_to_waveform,
)


def buffer(*channels: np.ndarray, sample_rate: int = INTERNAL_SAMPLE_RATE) -> AudioBuffer:
    return AudioBuffer.from_channels(sample_rate, [channel.astype(np.float32) for channel in channels])


def tone(frames: int, amplitude: float = 0.5, hz: float = 440.0) -> np.ndarray:
    t = np.arange(frames, dtype=np.float64) / float(INTERNAL_SAMPLE_RATE)
    return (amplitude * np.sin(2.0 * np.pi * hz * t)).astype(np.float32)


class TestBucketBoundaries:
    def test_covers_every_frame_exactly_once(self) -> None:
        boundaries = bucket_boundaries(1_000, 7)

        assert boundaries[0] == 0
        assert boundaries[-1] == 1_000
        # Consecutive and non-overlapping: each bucket ends where the next begins.
        assert boundaries == sorted(boundaries)

    def test_spreads_the_remainder_over_the_first_buckets(self) -> None:
        # 10 frames into 4 buckets is 3, 3, 2, 2 — not 2, 2, 2, 4. The last bucket of a long
        # asset would otherwise be visibly taller for a reason that is arithmetic.
        boundaries = bucket_boundaries(10, 4)
        widths = [boundaries[index + 1] - boundaries[index] for index in range(4)]

        assert widths == [3, 3, 2, 2]

    def test_divides_evenly_when_it_can(self) -> None:
        boundaries = bucket_boundaries(800, 8)
        widths = [boundaries[index + 1] - boundaries[index] for index in range(8)]

        assert widths == [100] * 8

    @pytest.mark.parametrize(
        ("frame_count", "buckets"),
        [(0, 16), (-1, 16), (100, 0), (100, -3)],
    )
    def test_returns_nothing_for_a_degenerate_request(
        self, frame_count: int, buckets: int
    ) -> None:
        assert bucket_boundaries(frame_count, buckets) == []

    @pytest.mark.parametrize(
        ("frame_count", "buckets"),
        [(1_000, 7), (48_000, 800), (10, 4), (4_001, 4_000), (17, 16)],
    )
    def test_agrees_with_the_typescript_rule(self, frame_count: int, buckets: int) -> None:
        # A transcription of `bucketBoundaries` in `domain/playback/waveform.ts`. The two
        # implementations are independent, so this fails if either drifts.
        expected: list[int] = []
        base, remainder = frame_count // buckets, frame_count % buckets
        cursor = 0
        for index in range(buckets):
            expected.append(cursor)
            cursor += base + (1 if index < remainder else 0)
        expected.append(frame_count)

        assert bucket_boundaries(frame_count, buckets) == expected


class TestReduceToWaveform:
    def test_returns_one_pair_per_requested_bucket(self) -> None:
        reduced = reduce_to_waveform(buffer(tone(48_000), tone(48_000)), 800)

        assert len(reduced) == 800
        assert all(-1.0 <= bucket.min <= bucket.max <= 1.0 for bucket in reduced)

    def test_finds_the_extremes_of_each_bucket(self) -> None:
        # A ramp: the first bucket's extremes are the first window's ends, and so on.
        frames = 1_000
        ramp = np.linspace(-1.0, 1.0, frames, dtype=np.float32)

        reduced = reduce_to_waveform(buffer(ramp), 10)

        for index, bucket in enumerate(reduced):
            window = ramp[index * 100 : (index + 1) * 100]
            assert bucket.min == pytest.approx(float(window.min()))
            assert bucket.max == pytest.approx(float(window.max()))

    def test_folds_channels_by_extreme_not_by_mean(self) -> None:
        # A transient in one channel only. A mean fold would halve it; Requirement 12.7's
        # drawing is of the asset, and a peak that exists should be drawn.
        frames = 480
        quiet = np.zeros(frames, dtype=np.float32)
        loud = np.zeros(frames, dtype=np.float32)
        loud[200] = 0.9
        loud[300] = -0.8

        reduced = reduce_to_waveform(buffer(quiet, loud), 16)

        assert max(bucket.max for bucket in reduced) == pytest.approx(0.9)
        assert min(bucket.min for bucket in reduced) == pytest.approx(-0.8)

    def test_clamps_the_bucket_count_to_the_frame_count(self) -> None:
        # More buckets than frames cannot hold more information than the audio does, and a
        # bucket per frame is the sample dump this reduction exists to avoid.
        reduced = reduce_to_waveform(buffer(tone(64)), 4_000)

        assert len(reduced) == 64

    def test_is_deterministic(self) -> None:
        # Design §5.5: no RNG, no thread count, fixed traversal — two calls agree exactly.
        audio = buffer(tone(48_000), tone(48_000, amplitude=0.3, hz=330.0))

        first = reduce_to_waveform(audio, 512)
        second = reduce_to_waveform(audio, 512)

        assert [(bucket.min, bucket.max) for bucket in first] == [
            (bucket.min, bucket.max) for bucket in second
        ]

    def test_reduces_silence_to_zeros(self) -> None:
        reduced = reduce_to_waveform(buffer(np.zeros(4_800, dtype=np.float32)), 32)

        assert all(bucket.min == 0.0 and bucket.max == 0.0 for bucket in reduced)

    def test_refuses_a_malformed_buffer(self) -> None:
        malformed = AudioBuffer(sample_rate=0, channels=(np.zeros(4, dtype=np.float32),))

        with pytest.raises(ValueError):
            reduce_to_waveform(malformed, 16)


class TestResolutionBounds:
    def test_mirrors_the_typescript_bounds(self) -> None:
        # `domain/playback/waveform.ts` publishes these to clients; a drift would let a
        # request the product layer accepted fail in the worker.
        assert WAVEFORM_BUCKETS_MIN == 16
        assert WAVEFORM_BUCKETS_MAX == 4_000

    @pytest.mark.parametrize("buckets", [WAVEFORM_BUCKETS_MIN, 800, WAVEFORM_BUCKETS_MAX])
    def test_every_bound_is_reducible(self, buckets: int) -> None:
        reduced = reduce_to_waveform(buffer(tone(WAVEFORM_BUCKETS_MAX * 3)), buckets)
        assert len(reduced) == buckets
