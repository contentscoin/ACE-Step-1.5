/**
 * Alignment scores and the order they impose (Requirements 22.6, 22.7).
 *
 * Two separable jobs, and only the second one is hard.
 *
 * **Normalisation (22.7).** The score must be recorded in `[0.0, 1.0]`. What the engine
 * reports is its own business, so `normalizeAlignmentScore` clamps into the range and
 * maps anything not a finite number to the floor. Clamping rather than rejecting because
 * 22.7 is a statement about what is *stored*, and a score marginally outside the range —
 * a cosine similarity of 1.0000000002 after floating-point accumulation — is not a
 * malformed result, it is a score at the top of the range.
 *
 * **Ordering (22.6).** "점수 내림차순으로 정렬하고, 두 산출물의 점수 차이가 0.001 이하인
 * 경우 시드 오름차순으로 정렬한다" — and taken literally as a pairwise comparator, that
 * rule is not a total order. Consider scores 0.5000, 0.5008 and 0.5016: the first pair is
 * within tolerance so seeds decide, the second pair is within tolerance so seeds decide,
 * but the outer pair is 0.0016 apart so score decides — and those three verdicts can
 * contradict each other. A comparator with that shape has no well-defined sorted result;
 * which permutation a sort produces would depend on the sorting algorithm.
 *
 * **This is a defect in Requirement 22.6, and it needs a decision rather than a clever
 * comparator.** The decision taken here, and the reason for it:
 *
 * 1. Sort by score, descending. This is the primary rule and it is not compromised.
 * 2. Partition that sequence into maximal *runs whose total span is at most the
 *    tolerance* — greedily, from the highest score down: a run keeps accepting the next
 *    output while it stays within 0.001 of the run's own highest score.
 * 3. Within a run, order by seed ascending.
 *
 * Because a run spans at most the tolerance, every pair inside it is within tolerance —
 * so step 3 only ever applies where 22.6 says the seed should decide. And because the
 * span is bounded by the tolerance, the resulting sequence is descending in score to
 * within 0.001 *globally*: for any `i < j`, `score[i] >= score[j] - 0.001`. That is the
 * exact invariant `isDescendingWithinTolerance` states and the property test asserts,
 * and it is the strongest form of "내림차순" that is simultaneously satisfiable with the
 * seed tie-break.
 *
 * What the decision gives up: a pair that is within tolerance of each other but lands on
 * either side of a run boundary is ordered by score rather than by seed. Nothing can
 * avoid that — it is the intransitivity itself — and ordering such a pair by score is the
 * failure that keeps rule 1 intact.
 *
 * Pure and deterministic. No engine, no audio, no clock: given the same scored outputs in
 * any input order, the ranking is the same, which is what lets Requirement 22.8's
 * reproducibility promise extend to the order of the list and not just its contents.
 */

import {
  SFX_ALIGNMENT_SCORE_MAX,
  SFX_ALIGNMENT_SCORE_MIN,
  SFX_ALIGNMENT_TIE_TOLERANCE,
} from './bounds';

/**
 * Requirement 22.7: a score fit to store.
 *
 * `NaN` and infinities become the floor rather than throwing, because an engine that
 * reports a broken score has produced audio that simply ranks last — discarding the
 * audio over an unusable number would lose work the user paid for.
 */
export function normalizeAlignmentScore(raw: number): number {
  if (!Number.isFinite(raw)) return SFX_ALIGNMENT_SCORE_MIN;
  return Math.min(SFX_ALIGNMENT_SCORE_MAX, Math.max(SFX_ALIGNMENT_SCORE_MIN, raw));
}

export function isNormalizedAlignmentScore(value: number): boolean {
  return (
    Number.isFinite(value) && value >= SFX_ALIGNMENT_SCORE_MIN && value <= SFX_ALIGNMENT_SCORE_MAX
  );
}

/** The two fields the ordering of 22.6 reads. Anything else rides along untouched. */
export interface AlignmentScored {
  /** Requirement 22.7: already normalised into `[0, 1]`. */
  readonly alignmentScore: number;
  /** Requirement 22.6's tie-break key. */
  readonly seed: number;
}

/** One ranked entry: the subject, its 0-based rank and which near-tie run it fell in. */
export interface Ranked<T> {
  readonly value: T;
  /** 0-based position in the returned order. */
  readonly rank: number;
  /**
   * 0-based index of the near-tie run this entry belongs to.
   *
   * Exposed rather than kept internal because it is the only way to state the ordering
   * invariant without restating the algorithm: entries sharing a `tieGroup` are ordered
   * by seed, and entries in different groups are ordered by score.
   */
  readonly tieGroup: number;
}

export interface RankAlignmentOptions {
  /** Requirement 22.6's 0.001. Injectable so a test can widen or collapse the runs. */
  readonly tieTolerance?: number;
}

/**
 * Requirement 22.6's ordering, as described in the module comment.
 *
 * Total: any array, including an empty one, has a ranking. The input is not mutated.
 */
export function rankByAlignment<T extends AlignmentScored>(
  scored: readonly T[],
  options: RankAlignmentOptions = {},
): readonly Ranked<T>[] {
  const tolerance = options.tieTolerance ?? SFX_ALIGNMENT_TIE_TOLERANCE;

  // Step 1 — score descending. The seed breaks exact score equality here purely so this
  // intermediate order is itself deterministic; step 3 is what implements 22.6's rule.
  const byScore = [...scored].sort(
    (first, second) =>
      second.alignmentScore - first.alignmentScore || first.seed - second.seed,
  );

  // Step 2 — maximal runs whose span is at most the tolerance, greedily from the top.
  const runs: T[][] = [];
  let openRun: T[] = [];
  let runTopScore = Number.POSITIVE_INFINITY;

  for (const entry of byScore) {
    if (openRun.length > 0 && runTopScore - entry.alignmentScore <= tolerance) {
      openRun.push(entry);
      continue;
    }
    if (openRun.length > 0) runs.push(openRun);
    openRun = [entry];
    runTopScore = entry.alignmentScore;
  }
  if (openRun.length > 0) runs.push(openRun);

  // Step 3 — seed ascending inside each run.
  const ranked: Ranked<T>[] = [];
  runs.forEach((run, tieGroup) => {
    for (const entry of [...run].sort((first, second) => first.seed - second.seed)) {
      ranked.push({ value: entry, rank: ranked.length, tieGroup });
    }
  });

  return ranked;
}

/**
 * The invariant of Requirement 22.6, checkable on any produced list.
 *
 * "Descending to within the tie tolerance": no later entry outscores an earlier one by
 * more than the tolerance. Exact equality of adjacent scores is descending; a later
 * entry scoring 0.0005 higher is the seed tie-break at work; a later entry scoring
 * 0.002 higher is a bug.
 */
export function isDescendingWithinTolerance(
  ordered: readonly AlignmentScored[],
  tieTolerance = SFX_ALIGNMENT_TIE_TOLERANCE,
): boolean {
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    if (current.alignmentScore - previous.alignmentScore > tieTolerance) return false;
  }
  return true;
}

/**
 * Within one near-tie run, seeds ascend — the second half of Requirement 22.6.
 *
 * Non-strict, so two entries carrying the same seed do not read as a violation. The
 * seeds of one request's variants are distinct by construction (`domain/sfx/seed.ts`),
 * so in practice the ascent is strict; the invariant is stated non-strictly because it
 * is about *ordering* and a duplicated seed is a distinctness failure, which is
 * Requirement 22.5's concern and has its own check.
 */
export function isSeedAscendingWithinTieGroups<T extends AlignmentScored>(
  ranked: readonly Ranked<T>[],
): boolean {
  for (let index = 1; index < ranked.length; index += 1) {
    const previous = ranked[index - 1];
    const current = ranked[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.tieGroup !== current.tieGroup) continue;
    if (!(previous.value.seed <= current.value.seed)) return false;
  }
  return true;
}
