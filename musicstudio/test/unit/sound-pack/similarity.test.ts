import { describe, expect, it } from 'vitest';

import {
  CUE_MFCC_DIMENSIONS,
  CUE_MFCC_HOP_MS,
  CUE_MFCC_MEL_BANDS,
  CUE_MFCC_NORMALISATION_LUFS,
  CUE_MFCC_SAMPLE_RATE,
  CUE_MFCC_WINDOW_MS,
  CUE_SIMILARITY_MAX,
  CUE_SIMILARITY_MIN,
  PACK_CUE_COUNT,
  PACK_CUE_PAIR_COUNT,
} from '../../../domain/sound-pack/bounds';
import {
  clampSimilarity,
  cosineSimilarity,
  evaluateCueSimilarity,
  examinedEveryPair,
  expectedPairCount,
  isCueMfccVector,
  pairwiseSimilarities,
  type CueMfccVector,
} from '../../../domain/sound-pack/similarity';
import { CUE_NAMES } from '../../../domain/sound-pack/taxonomy';

/**
 * Requirement 24.9's rule, over vectors stated rather than measured.
 *
 * The measurement is the Python DSP layer's (`dsp/src/musicstudio_dsp/mfcc.py`), which is why
 * this file states vectors instead of synthesising audio: the rule and the measurement are
 * separately checkable, and a test that had to synthesise 78 cues to assert that `n(n−1)/2` pairs
 * are enumerated would be evidence about the synthesiser.
 */

function vector(cueName: string, ...coefficients: readonly number[]): CueMfccVector {
  const padded = [...coefficients];
  while (padded.length < CUE_MFCC_DIMENSIONS) padded.push(0);
  return { cueName, coefficients: padded };
}

/**
 * `count` vectors spread over the 13-dimension space, pairwise well below the ceiling.
 *
 * Pseudorandom rather than a rotation of one basis vector, and a first attempt shows why: with
 * `coefficients[i % 13]` set to `1 + i`, cues 26 and 52 come out very nearly parallel — the
 * pattern repeats every 13 and the magnitudes grow linearly, so `(27, −29)` and `(53, −55)` point
 * almost the same way. Independent directions are what 78 timbrally distinct cues actually look
 * like, and a fixture that is accidentally collinear tests the wrong thing.
 */
function distinctVectors(count: number): readonly CueMfccVector[] {
  return Array.from({ length: count }, (_unused, index) => {
    let state = (index + 1) * 2_654_435_761;
    const coefficients = Array.from({ length: CUE_MFCC_DIMENSIONS }, () => {
      state = (Math.imul(state ^ (state >>> 15), 0x2545_f491) + 0x9e37_79b9) >>> 0;
      return state / 2_147_483_648 - 1;
    });
    return { cueName: CUE_NAMES[index] ?? `cue-${String(index)}`, coefficients };
  });
}

describe('Requirement 24.9\'s parameters are the clause\'s own', () => {
  it('states 13 coefficients, 40 mel bands, 25 ms windows at 10 ms, 48 kHz mono, −23 LUFS', () => {
    expect(CUE_MFCC_DIMENSIONS).toBe(13);
    expect(CUE_MFCC_MEL_BANDS).toBe(40);
    expect(CUE_MFCC_WINDOW_MS).toBe(25);
    expect(CUE_MFCC_HOP_MS).toBe(10);
    expect(CUE_MFCC_SAMPLE_RATE).toBe(48_000);
    expect(CUE_MFCC_NORMALISATION_LUFS).toBe(-23);
    expect(CUE_SIMILARITY_MIN).toBe(-1);
    expect(CUE_SIMILARITY_MAX).toBe(1);
  });
});

describe('cosine similarity', () => {
  it('is 1 for a vector against itself, exactly', () => {
    const coefficients = [1, -2, 3, 0.5, 4, -1, 2, 0, 1, 1, -3, 2, 0.25];
    expect(cosineSimilarity(coefficients, coefficients)).toBe(1);
  });

  it('is −1 for a vector against its negation', () => {
    const coefficients = [1, -2, 3, 0.5, 4, -1, 2, 0, 1, 1, -3, 2, 0.25];
    expect(cosineSimilarity(coefficients, coefficients.map((value) => -value))).toBe(-1);
  });

  it('is 0 for orthogonal vectors, and ignores length', () => {
    const left = vector('a', 1, 0).coefficients;
    const right = vector('b', 0, 1).coefficients;
    expect(cosineSimilarity(left, right)).toBe(0);
    expect(cosineSimilarity(left.map((v) => v * 100), right)).toBe(0);
  });

  it('is symmetric', () => {
    const left = vector('a', 1, 2, 3).coefficients;
    const right = vector('b', -1, 4, 0.5).coefficients;
    expect(cosineSimilarity(left, right)).toBeCloseTo(cosineSimilarity(right, left), 15);
  });

  it('answers 0 for a zero vector rather than NaN, so silence cannot pass 24.9 vacuously', () => {
    const zero = new Array<number>(CUE_MFCC_DIMENSIONS).fill(0);
    expect(cosineSimilarity(zero, vector('a', 1, 2).coefficients)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it('refuses vectors of different dimension rather than comparing a prefix', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/equal dimensions/);
  });

  it('clamps into the range Requirement 24.9 states', () => {
    expect(clampSimilarity(1.0000000002)).toBe(1);
    expect(clampSimilarity(-1.0000000002)).toBe(-1);
    expect(clampSimilarity(Number.NaN)).toBe(0);
    expect(clampSimilarity(0.5)).toBe(0.5);
  });
});

describe('the pairwise enumeration is exhaustive (Requirement 24.9\'s 3003)', () => {
  it('produces n(n−1)/2 pairs, and 3003 for a complete pack', () => {
    expect(pairwiseSimilarities(distinctVectors(PACK_CUE_COUNT))).toHaveLength(PACK_CUE_PAIR_COUNT);
    expect(PACK_CUE_PAIR_COUNT).toBe(3_003);
    for (const count of [0, 1, 2, 5, 20]) {
      expect(pairwiseSimilarities(distinctVectors(count))).toHaveLength(expectedPairCount(count));
    }
  });

  it('pairs each cue with every later cue exactly once, and never with itself', () => {
    const vectors = distinctVectors(20);
    const pairs = pairwiseSimilarities(vectors);

    const seen = new Set(pairs.map((pair) => `${String(pair.leftIndex)}:${String(pair.rightIndex)}`));
    expect(seen.size).toBe(pairs.length);
    for (const pair of pairs) {
      expect(pair.rightIndex).toBeGreaterThan(pair.leftIndex);
      expect(pair.leftCueName).not.toBe(pair.rightCueName);
    }
  });

  it('distinguishes "no pair exceeded" from "every pair was examined"', () => {
    const verdict = evaluateCueSimilarity(distinctVectors(70), 0.95);

    // 70 cues yield 2415 pairs, none above the ceiling — so the pack passes the ceiling and
    // fails the exhaustiveness check for a *complete* pack. Two different claims.
    expect(verdict.satisfied).toBe(true);
    expect(examinedEveryPair(verdict, 70)).toBe(true);
    expect(examinedEveryPair(verdict, PACK_CUE_COUNT)).toBe(false);
  });
});

describe('the verdict (Requirements 24.9, 24.22)', () => {
  it('passes a pack whose pairs are all at or below the ceiling, inclusive', () => {
    const parallel = [vector('hover', 1, 1), vector('press', 1, 1)];
    const exactly = cosineSimilarity(
      (parallel[0] as CueMfccVector).coefficients,
      (parallel[1] as CueMfccVector).coefficients,
    );

    // Identical vectors sit at exactly 1.0, so a ceiling of 1.0 admits them — "0.95 이하" is
    // inclusive, and the boundary is where an off-by-one would live.
    expect(exactly).toBe(1);
    expect(evaluateCueSimilarity(parallel, 1).satisfied).toBe(true);
    expect(evaluateCueSimilarity(parallel, 0.95).satisfied).toBe(false);
  });

  it('reports every exceeding pair with its measured similarity', () => {
    const vectors = [
      vector('hover', 1, 0, 0),
      vector('press', 1, 0.01, 0),
      vector('release', 0, 1, 0),
    ];

    const verdict = evaluateCueSimilarity(vectors, 0.95);

    expect(verdict.satisfied).toBe(false);
    if (verdict.satisfied) return;
    expect(verdict.exceeding).toHaveLength(1);
    expect(verdict.exceeding[0]?.leftCueName).toBe('hover');
    // Requirement 24.22 regenerates the *later* cue, which is the right-hand one.
    expect(verdict.exceeding[0]?.rightCueName).toBe('press');
    expect(verdict.exceeding[0]?.similarity).toBeGreaterThan(0.95);
    expect(verdict.maxSimilarity).toBe(verdict.exceeding[0]?.similarity);
  });

  it('reports the maximum even when the pack passes, for Requirement 34.8', () => {
    const verdict = evaluateCueSimilarity(distinctVectors(10), 0.95);

    expect(verdict.satisfied).toBe(true);
    expect(verdict.maxSimilarity).toBeLessThanOrEqual(0.95);
    expect(verdict.maxSimilarity).toBeGreaterThan(-1);
    expect(verdict.ceiling).toBe(0.95);
  });

  it('reports -Infinity as the maximum for a pack with no pairs', () => {
    expect(evaluateCueSimilarity([], 0.95).maxSimilarity).toBe(Number.NEGATIVE_INFINITY);
    expect(evaluateCueSimilarity([vector('hover', 1)], 0.95).pairCount).toBe(0);
  });

  it('takes the ceiling from its caller, since 34.4 lets an operator move it', () => {
    const vectors = distinctVectors(10);

    expect(evaluateCueSimilarity(vectors, 0.95).satisfied).toBe(true);
    expect(evaluateCueSimilarity(vectors, -1).satisfied).toBe(false);
  });

  it('treats a NaN similarity as exceeding rather than as satisfying', () => {
    const vectors = [vector('hover', Number.NaN, 1), vector('press', 1, 1)];

    // A NaN cannot arise from the clamped similarity, so this is a guard against a future change
    // that removed the clamp — a NaN compares false against the ceiling, which would silently
    // *pass* the pack.
    const verdict = evaluateCueSimilarity(vectors, 0.95);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.maxSimilarity).toBe(0);
  });
});

describe('vector shape', () => {
  it('accepts a 13-dimension finite vector and nothing else', () => {
    expect(isCueMfccVector(vector('hover', 1, 2, 3))).toBe(true);
    expect(isCueMfccVector({ cueName: 'hover', coefficients: [1, 2] })).toBe(false);
    expect(
      isCueMfccVector({ cueName: 'hover', coefficients: new Array<number>(13).fill(Number.NaN) }),
    ).toBe(false);
  });
});
