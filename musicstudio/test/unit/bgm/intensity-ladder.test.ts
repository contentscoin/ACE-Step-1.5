import { describe, expect, it } from 'vitest';

import {
  BGM_INTENSITY_GAP_MAX_LUFS,
  BGM_INTENSITY_GAP_MIN_LUFS,
  BGM_VARIANT_DURATION_SPREAD_MAX_MS,
} from '../../../domain/bgm/bounds';
import {
  LADDER_INVARIANT_REQUIREMENT,
  planIntensityLadder,
  verifyIntensityLadder,
  type MeasuredIntensityVariant,
} from '../../../domain/bgm/intensity-ladder';

/**
 * Intensity variants of one background-music cue.
 *
 * **Validates: Requirements 21.9, 21.10, 21.11**
 *
 * The module has two halves and they are tested as two different kinds of thing. The
 * *plan* satisfies Requirement 21.11 by construction, so its tests assert that no input
 * can make it produce an invalid ladder. The *verification* judges what an engine
 * actually returned, so its tests walk each boundary the requirement names.
 */

function variant(
  step: number,
  loudnessLufs: number,
  durationMs = 8_000,
): MeasuredIntensityVariant {
  return {
    assetId: `bgm-asset-${String(step)}`,
    step,
    durationMs,
    integratedLoudnessLufs: loudnessLufs,
  };
}

describe('planning a ladder (Requirements 21.9, 21.11)', () => {
  it('produces one entry per requested variant, stepped 1 upwards', () => {
    const plan = planIntensityLadder({ count: 4, baseLoudnessLufs: -20, gapLufs: 3 });

    expect(plan.map((entry) => entry.step)).toEqual([1, 2, 3, 4]);
  });

  it('separates adjacent targets by exactly the requested gap', () => {
    const plan = planIntensityLadder({ count: 4, baseLoudnessLufs: -20, gapLufs: 2.5 });

    expect(plan.map((entry) => entry.targetLoudnessLufs)).toEqual([-20, -17.5, -15, -12.5]);
  });

  it('starts step 1 at the base loudness', () => {
    expect(
      planIntensityLadder({ count: 2, baseLoudnessLufs: -18, gapLufs: 4 })[0]
        ?.targetLoudnessLufs,
    ).toBe(-18);
  });

  it('produces a single entry for a count of 1', () => {
    // Requirement 21.9 permits a count of 1; a ladder of one is not a degenerate case.
    expect(planIntensityLadder({ count: 1, baseLoudnessLufs: -20, gapLufs: 3 })).toEqual([
      { step: 1, targetLoudnessLufs: -20 },
    ]);
  });

  it('cannot be made to plan an invalid ladder, whatever it is handed', () => {
    // The validator already rejects out-of-range requests with the offending field, so a
    // bad value arriving here is a programming error — and clamping keeps a programming
    // error from producing a ladder that breaks the invariant the plan exists to uphold.
    for (const count of [-3, 0, 9, 2.6, Number.NaN]) {
      for (const gapLufs of [-5, 0, 40, Number.POSITIVE_INFINITY]) {
        const plan = planIntensityLadder({ count, baseLoudnessLufs: -20, gapLufs });

        expect(plan.length).toBeGreaterThanOrEqual(1);
        expect(plan.length).toBeLessThanOrEqual(4);
        expect(new Set(plan.map((entry) => entry.step)).size).toBe(plan.length);

        const verdict = verifyIntensityLadder(
          plan.map((entry) => variant(entry.step, entry.targetLoudnessLufs)),
        );
        expect(verdict.satisfied).toBe(true);
      }
    }
  });
});

describe('verifying a produced set (Requirement 21.9)', () => {
  it('accepts 1 to 4 variants', () => {
    for (const count of [1, 2, 3, 4]) {
      const variants = Array.from({ length: count }, (_unused, index) =>
        variant(index + 1, -20 + 3 * index),
      );
      expect(verifyIntensityLadder(variants).unmet).toEqual([]);
    }
  });

  it('rejects an empty set and a set of 5', () => {
    expect(verifyIntensityLadder([]).unmet).toContain('variant_count');
    expect(
      verifyIntensityLadder(
        Array.from({ length: 5 }, (_unused, index) => variant(index + 1, -20 + 1.5 * index)),
      ).unmet,
    ).toContain('variant_count');
  });
});

describe('length agreement (Requirement 21.10)', () => {
  it('accepts a spread of exactly 10 ms', () => {
    const verdict = verifyIntensityLadder([
      variant(1, -20, 8_000),
      variant(2, -17, 8_010),
    ]);

    expect(verdict.durationSpreadMs).toBe(BGM_VARIANT_DURATION_SPREAD_MAX_MS);
    expect(verdict.unmet).not.toContain('duration_spread');
  });

  it('rejects a spread of 11 ms', () => {
    const verdict = verifyIntensityLadder([
      variant(1, -20, 8_000),
      variant(2, -17, 8_011),
    ]);

    expect(verdict.unmet).toContain('duration_spread');
  });

  it('measures the spread as longest minus shortest across the whole set', () => {
    const verdict = verifyIntensityLadder([
      variant(1, -20, 8_000),
      variant(2, -17, 8_004),
      variant(3, -14, 8_009),
    ]);

    expect(verdict.durationSpreadMs).toBe(9);
    expect(verdict.unmet).toEqual([]);
  });
});

describe('intensity steps (Requirement 21.11, first half)', () => {
  it('rejects duplicate steps', () => {
    expect(
      verifyIntensityLadder([variant(2, -20), variant(2, -17)]).unmet,
    ).toContain('intensity_steps');
  });

  it('rejects a step outside 1–4', () => {
    for (const step of [0, 5, -1]) {
      expect(verifyIntensityLadder([variant(step, -20)]).unmet).toContain('intensity_steps');
    }
  });

  it('rejects a non-integer step', () => {
    expect(verifyIntensityLadder([variant(1.5, -20)]).unmet).toContain('intensity_steps');
  });

  it('accepts a non-contiguous set of steps inside 1–4', () => {
    // Requirement 21.11 asks for distinct values in 1–4, not for a contiguous run: a
    // caller asking for two variants may legitimately want steps 1 and 4.
    const verdict = verifyIntensityLadder([variant(1, -20), variant(4, -16)]);

    expect(verdict.unmet).toEqual([]);
    expect(verdict.gapsLufs).toEqual([4]);
  });
});

describe('loudness ladder (Requirement 21.11, second half)', () => {
  it('accepts a gap of exactly 1.0 LUFS and exactly 6.0 LUFS', () => {
    for (const gap of [BGM_INTENSITY_GAP_MIN_LUFS, BGM_INTENSITY_GAP_MAX_LUFS]) {
      const verdict = verifyIntensityLadder([variant(1, -22), variant(2, -22 + gap)]);

      expect(verdict.gapsLufs).toEqual([gap]);
      expect(verdict.unmet).not.toContain('loudness_gap');
    }
  });

  it('rejects a gap below 1.0 LUFS', () => {
    expect(
      verifyIntensityLadder([variant(1, -20), variant(2, -19.5)]).unmet,
    ).toContain('loudness_gap');
  });

  it('rejects a gap above 6.0 LUFS', () => {
    expect(
      verifyIntensityLadder([variant(1, -20), variant(2, -13.5)]).unmet,
    ).toContain('loudness_gap');
  });

  it('rejects a ladder that goes the wrong way', () => {
    // A negative gap means step 2 is quieter than step 1, which is not "1.0LUFS 이상
    // 크게" by any reading.
    const verdict = verifyIntensityLadder([variant(1, -14), variant(2, -20)]);

    expect(verdict.gapsLufs).toEqual([-6]);
    expect(verdict.unmet).toContain('loudness_gap');
  });

  it('compares in step order, not in submission order', () => {
    // Requirement 21.11 compares a variant with "한 단계 낮은" one — its neighbour in
    // step order. A set handed over shuffled must still be judged as the ladder it is.
    const verdict = verifyIntensityLadder([
      variant(3, -14),
      variant(1, -20),
      variant(2, -17),
    ]);

    expect(verdict.gapsLufs).toEqual([3, 3]);
    expect(verdict.unmet).toEqual([]);
  });

  it('is satisfied vacuously for a single variant', () => {
    // There is no adjacent pair, and Requirement 21.9 permits a count of 1, so a rule
    // about gaps must not make the permitted case fail.
    const verdict = verifyIntensityLadder([variant(1, -20)]);

    expect(verdict.gapsLufs).toEqual([]);
    expect(verdict.satisfied).toBe(true);
  });

  it('rejects an unmeasurable loudness rather than treating silence as a step', () => {
    const verdict = verifyIntensityLadder([
      variant(1, Number.NEGATIVE_INFINITY),
      variant(2, -17),
    ]);

    expect(verdict.unmet).toContain('loudness_gap');
  });

  it('names the requirement behind each invariant', () => {
    expect(LADDER_INVARIANT_REQUIREMENT).toEqual({
      variant_count: '21.9',
      duration_spread: '21.10',
      intensity_steps: '21.11',
      loudness_gap: '21.11',
    });
  });
});
