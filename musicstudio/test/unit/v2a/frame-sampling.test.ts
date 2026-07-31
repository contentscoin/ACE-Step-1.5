import { describe, expect, it } from 'vitest';

import { V2A_SAMPLE_FRAME_RATE } from '../../../domain/v2a/bounds';
import {
  isNonDecreasing,
  isWithinSource,
  outputFrameCount,
  planFrameSampling,
} from '../../../domain/v2a/frame-sampling';

/**
 * 24 fps sampling of the source frames.
 *
 * **Validates: Requirements 23.6**
 *
 * The module produces a *plan* — one source frame index per output frame — because decoding needs
 * a codec that task 3.1 owns while *choosing which frame goes where* is arithmetic, and getting
 * that arithmetic wrong is how foley ends up a frame late. So these tests read the plan directly.
 */

describe('the target rate is always 24 (Requirement 23.6)', () => {
  it('feeds the engine 24 fps whatever the source rate', () => {
    for (const sourceFrameRate of [8, 12, 23.976, 24, 30, 60, 120]) {
      const plan = planFrameSampling({
        sourceFrameRate,
        sourceFrameCount: Math.max(1, Math.round(sourceFrameRate)),
        durationMs: 1_000,
      });

      expect(plan.targetFrameRate).toBe(V2A_SAMPLE_FRAME_RATE);
      expect(plan.sourceIndices).toHaveLength(24);
    }
  });

  it('derives the output frame count from the duration, floored at one frame', () => {
    expect(outputFrameCount(1_000)).toBe(24);
    expect(outputFrameCount(500)).toBe(12);
    expect(outputFrameCount(8_000)).toBe(192);
    // A segment the engine is asked about must be shown at least one frame.
    expect(outputFrameCount(0)).toBe(1);
    expect(outputFrameCount(10)).toBe(1);
  });

  it('answers rather than throwing for an unusable rate', () => {
    expect(outputFrameCount(1_000, 0)).toBe(1);
    expect(outputFrameCount(Number.NaN)).toBe(1);
  });
});

describe('a source slower than 24 fps duplicates the preceding frame (Requirement 23.6)', () => {
  it('repeats each 12 fps frame exactly once', () => {
    const plan = planFrameSampling({
      sourceFrameRate: 12,
      sourceFrameCount: 12,
      durationMs: 1_000,
    });

    expect(plan.sourceIndices).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11,
    ]);
    // 12 of the 24 output frames repeat their predecessor.
    expect(plan.duplicatedCount).toBe(12);
    expect(plan.clampedCount).toBe(0);
  });

  it('repeats each 8 fps frame twice — 23.2s slowest permitted source', () => {
    const plan = planFrameSampling({ sourceFrameRate: 8, sourceFrameCount: 8, durationMs: 1_000 });

    expect(plan.sourceIndices.slice(0, 6)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(plan.duplicatedCount).toBe(16);
  });

  it('shows each source frame at least once, so no source frame is skipped', () => {
    const plan = planFrameSampling({ sourceFrameRate: 8, sourceFrameCount: 8, durationMs: 1_000 });

    expect(new Set(plan.sourceIndices).size).toBe(8);
  });
});

describe('a source at or above 24 fps never duplicates (Requirement 23.6s IF)', () => {
  it('maps consecutive output frames to distinct source frames at 24, 30 and 120 fps', () => {
    for (const sourceFrameRate of [24, 30, 60, 120]) {
      const plan = planFrameSampling({
        sourceFrameRate,
        sourceFrameCount: sourceFrameRate * 2,
        durationMs: 2_000,
      });

      expect(plan.duplicatedCount).toBe(0);
      expect(plan.clampedCount).toBe(0);
    }
  });

  it('drops intermediate frames at 30 fps rather than resampling them', () => {
    const plan = planFrameSampling({ sourceFrameRate: 30, sourceFrameCount: 30, durationMs: 1_000 });

    // floor(j × 30 / 24) — every fifth source frame is never shown.
    expect(plan.sourceIndices.slice(0, 9)).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 10]);
  });
});

describe('plan invariants', () => {
  it('never reorders frames, so motion cannot run backwards', () => {
    for (const sourceFrameRate of [8, 12, 23.976, 24, 29.97, 60, 120]) {
      const plan = planFrameSampling({
        sourceFrameRate,
        sourceFrameCount: Math.max(1, Math.round(sourceFrameRate * 3)),
        durationMs: 3_000,
      });

      expect(isNonDecreasing(plan.sourceIndices)).toBe(true);
    }
  });

  it('addresses only frames that exist, clamping the tail rather than inventing one', () => {
    // A rounded frame count one frame short of what the duration implies.
    const plan = planFrameSampling({ sourceFrameRate: 30, sourceFrameCount: 3, durationMs: 1_000 });

    expect(isWithinSource(plan)).toBe(true);
    expect(plan.sourceIndices.every((index) => index <= 2)).toBe(true);
    // Clamping is reported separately from 23.6's duplication, so "the source was slow" stays
    // distinguishable from "the source ran out".
    expect(plan.clampedCount).toBeGreaterThan(0);
  });

  it('treats a source of zero frames as one frame rather than as an empty plan', () => {
    const plan = planFrameSampling({ sourceFrameRate: 30, sourceFrameCount: 0, durationMs: 100 });

    expect(plan.sourceFrameCount).toBe(1);
    expect(isWithinSource(plan)).toBe(true);
  });

  it('detects a decreasing index list, so the invariant is not vacuous', () => {
    expect(isNonDecreasing([0, 1, 1, 2])).toBe(true);
    expect(isNonDecreasing([0, 2, 1])).toBe(false);
  });
});
