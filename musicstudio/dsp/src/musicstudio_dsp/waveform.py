"""Waveform reduction for Requirement 12.7.

A drawing needs the extreme of each bucket, not the samples: a five-minute asset is
14.4 million frames and a client draws a few hundred pixels. What the product layer
decided — two extremes per bucket, normalised to [-1, 1] — is recorded in
``domain/playback/waveform.ts``; this module is the reduction itself.

The bucket boundaries are computed here the same way that module computes them, and
``test/test_waveform.py`` pins the agreement: frames rarely divide evenly into buckets and
the remainder is spread over the first buckets rather than piled onto the last, which
would make the final bucket of a long asset visibly taller for a reason that is arithmetic
rather than audio.

Deterministic, like every other reduction in this package: no RNG, no thread count, and a
fixed traversal order, so two calls on one asset give the same drawing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audio_buffer import AudioBuffer

__all__ = [
    "WAVEFORM_BUCKETS_MAX",
    "WAVEFORM_BUCKETS_MIN",
    "WaveformBucket",
    "bucket_boundaries",
    "reduce_to_waveform",
]

#: Mirrors ``domain/playback/waveform.ts``. `test_waveform.py` fails if the two drift.
WAVEFORM_BUCKETS_MIN = 16
WAVEFORM_BUCKETS_MAX = 4_000


@dataclass(frozen=True)
class WaveformBucket:
    """One bucket's extremes, in [-1, 1]."""

    min: float
    max: float


def bucket_boundaries(frame_count: int, buckets: int) -> list[int]:
    """Where each bucket begins, plus a final entry at ``frame_count``.

    The same spreading rule as ``bucketBoundaries`` in the TypeScript module: the first
    ``frame_count % buckets`` buckets take one extra frame.
    """
    if frame_count <= 0 or buckets <= 0:
        return []

    base, remainder = divmod(frame_count, buckets)
    boundaries: list[int] = []
    cursor = 0
    for index in range(buckets):
        boundaries.append(cursor)
        cursor += base + (1 if index < remainder else 0)
    boundaries.append(frame_count)
    return boundaries


def reduce_to_waveform(audio: AudioBuffer, buckets: int) -> list[WaveformBucket]:
    """Reduce every channel to ``buckets`` pairs of extremes.

    Channels are folded together — the extreme of a bucket is the extreme across all of
    them — because Requirement 12.7 asks for *the asset's* waveform and a two-channel
    drawing would need the client to decide what to do with the second. The fold is a
    maximum rather than a mean, so a transient present in one channel stays visible.

    ``buckets`` is clamped to the frame count: a bucket per frame is the sample dump this
    reduction exists to avoid, and asking for more buckets than frames cannot produce more
    information than the audio holds.
    """
    if not audio.is_well_formed:
        raise ValueError("input audio is not well formed")

    frames = audio.frame_count
    resolved = max(1, min(int(buckets), frames))
    boundaries = bucket_boundaries(frames, resolved)

    # One stacked view rather than a per-channel loop with a merge afterwards: the fold is
    # then a single reduction over an axis, which is both faster and impossible to get
    # inconsistent between the two extremes.
    stacked = np.stack(audio.channels, axis=0)

    result: list[WaveformBucket] = []
    for index in range(resolved):
        start = boundaries[index]
        end = boundaries[index + 1]
        if end <= start:
            result.append(WaveformBucket(min=0.0, max=0.0))
            continue

        window = stacked[:, start:end]
        result.append(
            WaveformBucket(min=float(np.min(window)), max=float(np.max(window)))
        )

    return result
