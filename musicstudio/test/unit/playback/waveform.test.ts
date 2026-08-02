import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bucketBoundaries,
  bucketStartMs,
  isWaveformBucketCount,
  resolveBucketCount,
  WAVEFORM_BUCKETS_DEFAULT,
  WAVEFORM_BUCKETS_MAX,
  WAVEFORM_BUCKETS_MIN,
} from '../../../domain/playback/waveform';

/**
 * Waveform bucket arithmetic.
 *
 * **Validates: Requirement 12.7**
 *
 * The same arithmetic exists in `dsp/src/musicstudio_dsp/waveform.py`, and
 * `dsp/test/test_waveform.py` checks the Python side against a transcription of this rule.
 * The pairing matters because a drift shows up as a waveform that does not line up with the
 * position a client seeks to — visible in a screenshot, invisible in a length assertion.
 */

describe('bucketBoundaries (Requirement 12.7)', () => {
  it('covers every frame exactly once', () => {
    const boundaries = bucketBoundaries(1_000, 7);

    expect(boundaries[0]).toBe(0);
    expect(boundaries.at(-1)).toBe(1_000);
    expect(boundaries).toHaveLength(8);
  });

  it('spreads the remainder over the first buckets', () => {
    // 10 into 4 is 3, 3, 2, 2 — not 2, 2, 2, 4, which would make the final bucket of a long
    // asset visibly taller for a reason that is arithmetic rather than audio.
    const boundaries = bucketBoundaries(10, 4);
    const widths = [0, 1, 2, 3].map((index) => (boundaries[index + 1] ?? 0) - (boundaries[index] ?? 0));

    expect(widths).toEqual([3, 3, 2, 2]);
  });

  it('divides evenly when it can', () => {
    const boundaries = bucketBoundaries(800, 8);
    const widths = Array.from({ length: 8 }, (_, index) => (boundaries[index + 1] ?? 0) - (boundaries[index] ?? 0));

    expect(widths).toEqual([100, 100, 100, 100, 100, 100, 100, 100]);
  });

  it('returns nothing for a degenerate request', () => {
    expect(bucketBoundaries(0, 16)).toEqual([]);
    expect(bucketBoundaries(-1, 16)).toEqual([]);
    expect(bucketBoundaries(100, 0)).toEqual([]);
  });

  it('never differs by more than one frame between the widest and narrowest bucket', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 1, max: WAVEFORM_BUCKETS_MAX }),
        (frameCount, buckets) => {
          const boundaries = bucketBoundaries(frameCount, buckets);
          const widths = Array.from(
            { length: buckets },
            (_, index) => (boundaries[index + 1] ?? 0) - (boundaries[index] ?? 0),
          );

          expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
          expect(widths.reduce((sum, width) => sum + width, 0)).toBe(frameCount);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the requested resolution (Requirements 12.7, 12.8)', () => {
  it('accepts an integer inside the published bounds', () => {
    for (const value of [WAVEFORM_BUCKETS_MIN, WAVEFORM_BUCKETS_DEFAULT, WAVEFORM_BUCKETS_MAX]) {
      expect(isWaveformBucketCount(value)).toBe(true);
    }
  });

  it('refuses anything outside them, and anything that is not an integer', () => {
    for (const value of [15, 4_001, 0, -1, 800.5, NaN, '800', null, undefined]) {
      expect(isWaveformBucketCount(value)).toBe(false);
    }
  });

  it('falls back to the default when nothing was asked for', () => {
    expect(resolveBucketCount(undefined, 10_000_000)).toBe(WAVEFORM_BUCKETS_DEFAULT);
  });

  it('never plans more buckets than there are frames', () => {
    // A bucket per frame is the sample dump Requirement 12.7 exists to avoid.
    expect(resolveBucketCount(4_000, 64)).toBe(64);
    expect(resolveBucketCount(undefined, 5)).toBe(5);
  });
});

describe('mapping a bucket back to a time (Requirement 12.5)', () => {
  it('places bucket zero at the start and the last boundary at the end', () => {
    expect(bucketStartMs(0, 100, 60_000)).toBe(0);
    expect(bucketStartMs(100, 100, 60_000)).toBe(60_000);
  });

  it('clamps an index outside the bucket list', () => {
    expect(bucketStartMs(-5, 100, 60_000)).toBe(0);
    expect(bucketStartMs(500, 100, 60_000)).toBe(60_000);
  });

  it('is monotonic in the index', () => {
    let previous = -1;
    for (let index = 0; index <= 800; index += 1) {
      const start = bucketStartMs(index, 800, 180_000);
      expect(start).toBeGreaterThan(previous);
      previous = start;
    }
  });
});
