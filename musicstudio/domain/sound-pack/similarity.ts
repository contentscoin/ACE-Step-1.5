/**
 * Requirement 24.9: the cue-pair similarity rule, over MFCC vectors measured elsewhere.
 *
 * 24.9 is one long clause and it splits cleanly into a *measurement* and a *rule*:
 *
 * - the measurement — resample to 48 kHz mono, normalise to −23 LUFS, take a 25 ms /
 *   10 ms / 40-band log-mel spectrogram, keep cepstral coefficients 1…13, average over
 *   time — yields one 13-dimension vector per cue;
 * - the rule — every one of the 3003 distinct pairs has cosine similarity ≤ 0.95, and the
 *   similarity is a value in `[−1, 1]`.
 *
 * **The measurement is Python's and this module does not repeat it.** It lives in
 * `dsp/src/musicstudio_dsp/mfcc.py`, which is where design §5.5 puts mel-spectrogram and
 * MFCC work, and it arrives here through `CueMfccPort`. That is a deliberate departure
 * from how Requirement 24.7's loudness is handled — `domain/audio/loudness.ts` computes
 * that in TypeScript as well — and the difference is the cost of being wrong. A K-weighted
 * mean square is forty lines whose agreement with the standard is checkable against
 * published test vectors. An FFT, a mel filterbank and a DCT-II are not, and two of them
 * that disagreed by half a percent would put pairs on opposite sides of 0.95 depending on
 * which side of the process boundary the check happened to run. One declaration of the
 * measurement, in the layer that owns DSP.
 *
 * **The rule is here, and it is exhaustive.** `pairwiseSimilarities` enumerates every
 * `i < j`, not a sample: a report holding fewer than `n(n−1)/2` entries has not examined
 * the pack Requirement 24.9 describes, and `PACK_CUE_PAIR_COUNT` exists so a caller can
 * assert that it did. 3003 pairs of 13-dimension dot products is about 40 000
 * multiplications — the exhaustive check costs less than one cue's FFT, so there is no
 * efficiency argument for sampling and it is not offered as an option.
 */

import {
  CUE_MFCC_DIMENSIONS,
  CUE_SIMILARITY_MAX,
  CUE_SIMILARITY_MIN,
  PACK_CUE_PAIR_COUNT,
} from './bounds';

/** One cue's 13-dimension mean MFCC vector, as measured by the DSP layer. */
export interface CueMfccVector {
  readonly cueName: string;
  /** Coefficients 1…13, time-averaged. Exactly `CUE_MFCC_DIMENSIONS` values. */
  readonly coefficients: readonly number[];
}

/** One pair and its measured similarity. */
export interface CuePairSimilarity {
  readonly leftCueName: string;
  readonly rightCueName: string;
  /** Index of each cue in the input order, so 24.22's "later" cue is identifiable. */
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly similarity: number;
}

export type CueSimilarityVerdict =
  | {
      readonly satisfied: true;
      readonly pairCount: number;
      readonly maxSimilarity: number;
      readonly ceiling: number;
    }
  | {
      readonly satisfied: false;
      readonly pairCount: number;
      readonly maxSimilarity: number;
      readonly ceiling: number;
      /** Requirement 24.22: the offending pairs and their measured values. */
      readonly exceeding: readonly CuePairSimilarity[];
    };

/**
 * Cosine similarity of two vectors, clamped into Requirement 24.9's stated range.
 *
 * The clamp is not cosmetic. 24.9 requires the value be "−1.0 이상 1.0 이하", and the
 * quotient `dot / (‖a‖·‖b‖)` computed in floating point can land a few ulps outside that
 * for vectors that are parallel or antiparallel — most visibly for `cosineSimilarity(v, v)`,
 * which must be exactly representable as 1.0 for the reflexivity a reader expects. Clamping
 * makes the returned value satisfy the clause's own range for every input, which is what
 * lets the range be asserted as an invariant rather than as an approximation.
 *
 * A zero vector has no direction, so its similarity with anything is **0** — not `NaN`, and
 * not 1. `NaN` would compare false against the ceiling and so silently *pass* 24.9, which
 * is the worst of the three answers: a pack of silent cues would be declared distinct.
 * 0 says "no evidence of similarity", which is the truth about a vector with no direction,
 * and it cannot mask a violation.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(
      `cosine similarity needs equal dimensions, got ${String(left.length)} and ${String(right.length)}`,
    );
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [index, leftValue] of left.entries()) {
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  // `sqrt(l · r)` rather than `sqrt(l) · sqrt(r)`: one rounding instead of three, which makes
  // `cosineSimilarity(v, v)` come out at exactly 1.0 rather than at 1 − 2ε. That matters beyond
  // tidiness — a reflexive similarity that is not exactly 1 makes the reflexivity a reader
  // expects into an approximation, and it is free to get right.
  const denominator = Math.sqrt(leftNorm * rightNorm);
  if (!(denominator > 0)) return 0;

  return clampSimilarity(dot / denominator);
}

export function clampSimilarity(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(CUE_SIMILARITY_MAX, Math.max(CUE_SIMILARITY_MIN, value));
}

/**
 * Every distinct pair, in `(i < j)` order. `n(n−1)/2` entries, always.
 *
 * Ordered so that `rightIndex > leftIndex` for every entry, which is what makes
 * Requirement 24.22's "나중에 생성된 큐" — the later-generated cue of the pair — readable
 * straight off the result as `rightCueName`, given cues in generation order.
 */
export function pairwiseSimilarities(
  vectors: readonly CueMfccVector[],
): readonly CuePairSimilarity[] {
  const pairs: CuePairSimilarity[] = [];
  for (let left = 0; left < vectors.length; left += 1) {
    const leftVector = vectors[left] as CueMfccVector;
    for (let right = left + 1; right < vectors.length; right += 1) {
      const rightVector = vectors[right] as CueMfccVector;
      pairs.push({
        leftCueName: leftVector.cueName,
        rightCueName: rightVector.cueName,
        leftIndex: left,
        rightIndex: right,
        similarity: cosineSimilarity(leftVector.coefficients, rightVector.coefficients),
      });
    }
  }
  return pairs;
}

/** The pair count an exhaustive check over `cueCount` cues must reach. */
export function expectedPairCount(cueCount: number): number {
  return (cueCount * (cueCount - 1)) / 2;
}

/**
 * Requirement 24.9's verdict for a whole pack.
 *
 * `ceiling` is a parameter rather than a constant: it is the Quality_Threshold_Set member
 * `cue_pair_similarity_max`, and Requirement 34.4 lets an operator move it between two
 * runs. The caller reads it once per pack (see `soundPackThresholds`) and passes it here.
 *
 * `maxSimilarity` is reported whether or not the pack passed, because a pack that passes at
 * 0.94 and one that passes at 0.10 are different situations and Requirement 34.8's
 * calibration review needs to be able to tell them apart.
 */
export function evaluateCueSimilarity(
  vectors: readonly CueMfccVector[],
  ceiling: number,
): CueSimilarityVerdict {
  const pairs = pairwiseSimilarities(vectors);
  const maxSimilarity = pairs.reduce(
    (worst, pair) => Math.max(worst, pair.similarity),
    Number.NEGATIVE_INFINITY,
  );
  // Written `!(similarity <= ceiling)` so a `NaN` similarity is treated as exceeding rather
  // than as satisfying — the same discipline `domain/effects/equivalence.ts` applies.
  const exceeding = pairs.filter((pair) => !(pair.similarity <= ceiling));

  if (exceeding.length === 0) {
    return { satisfied: true, pairCount: pairs.length, maxSimilarity, ceiling };
  }
  return { satisfied: false, pairCount: pairs.length, maxSimilarity, ceiling, exceeding };
}

/**
 * Whether a report examined the whole pack.
 *
 * Separate from the verdict on purpose. "No pair exceeded the ceiling" and "every pair was
 * looked at" are different claims, and a bug that dropped cues from the comparison would
 * make the first true while the second is false — which is exactly the failure mode
 * Requirement 24.9's explicit "3003개" guards against. A caller checking a full pack asserts
 * both.
 */
export function examinedEveryPair(verdict: CueSimilarityVerdict, cueCount: number): boolean {
  return verdict.pairCount === expectedPairCount(cueCount);
}

/** The pair count for a complete pack: 3003. Restated for readability at call sites. */
export const COMPLETE_PACK_PAIR_COUNT = PACK_CUE_PAIR_COUNT;

/** Whether a vector has the dimension Requirement 24.9 fixes. */
export function isCueMfccVector(vector: CueMfccVector): boolean {
  return (
    vector.coefficients.length === CUE_MFCC_DIMENSIONS &&
    vector.coefficients.every((value) => Number.isFinite(value))
  );
}
