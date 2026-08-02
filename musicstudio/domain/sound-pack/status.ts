/**
 * A `Sound_Pack`'s status (design §4.1's `enum status`).
 *
 * Requirement 24 names three outcomes and never enumerates them together, so the list is
 * assembled from the clauses that produce each one:
 *
 * - **`complete`** — 24.2 is satisfied: 78 cues, and the cue name set equals the taxonomy's.
 * - **`incomplete`** — 24.3 (a cue is missing) or 24.21 (a cue's generation failed after its
 *   retries). Both say "미완성 상태로 표시" and both keep the cues that succeeded, so they are
 *   one state rather than two: the difference between them is *why*, which the returned cue
 *   name list carries, and a fourth state would let two clauses that ask for the same thing
 *   drift apart.
 * - **`review_required`** — 24.22: a cue pair still exceeded the similarity ceiling after
 *   three reseeded regenerations. A separate state from `incomplete` because the pack is
 *   *whole* — all 78 cues exist and are usable — and what is wrong is a judgement a person
 *   has to make. Calling it incomplete would tell the user to wait for cues that are
 *   already there.
 *
 * A pack that fails Requirement 24.7's loudness band, 24.4/24.5's length range or 24.6's seam
 * criteria is also `review_required`, and that is an **interpretation** rather than a clause:
 * 24.4, 24.5, 24.6 and 24.7 are written as invariants with no stated consequence for
 * violation. The alternatives
 * were to fail the whole pack (which would throw away 77 good cues over one cue's level) or
 * to mark it incomplete (which would misdescribe a whole pack). `review_required` is the
 * state whose meaning already is "everything is here and something needs a human", so the
 * unlegislated cases join it. Recorded in this task's report as an interpretation.
 *
 * Ordered least-to-most attention needed, and `packStatus` takes the worst applicable — so
 * a pack that is both missing a cue and holding a too-similar pair reports `incomplete`,
 * the one that has to be resolved first.
 */

export const SOUND_PACK_STATUSES = ['complete', 'review_required', 'incomplete'] as const;

export type SoundPackStatus = (typeof SOUND_PACK_STATUSES)[number];

export function isSoundPackStatus(value: unknown): value is SoundPackStatus {
  return typeof value === 'string' && (SOUND_PACK_STATUSES as readonly string[]).includes(value);
}

/** Requirement 24.2: only a pack with every cue is complete. */
export interface PackStatusInput {
  /** Requirements 24.3, 24.21: taxonomy names this pack has no audio for. */
  readonly missingCueNames: readonly string[];
  /** Requirement 24.22: pairs still above the ceiling after the reseeded regenerations. */
  readonly unresolvedSimilarPairs: number;
  /** Requirement 24.7: cues outside the loudness band. See the header on this reading. */
  readonly loudnessOffenders: number;
  /** Requirements 24.4, 24.5: cues whose length is outside their kind's range. */
  readonly lengthOffenders: number;
  /** Requirement 24.6: loop cues whose seam fails either of its two criteria. */
  readonly seamOffenders: number;
}

/**
 * The worst applicable status.
 *
 * A single function rather than a chain of `if`s at the call site, so the precedence is
 * stated once and the service cannot report `complete` for a pack it also described as
 * holding four missing cues.
 */
export function packStatus(input: PackStatusInput): SoundPackStatus {
  if (input.missingCueNames.length > 0) return 'incomplete';
  if (
    input.unresolvedSimilarPairs > 0 ||
    input.loudnessOffenders > 0 ||
    input.lengthOffenders > 0 ||
    input.seamOffenders > 0
  ) {
    return 'review_required';
  }
  return 'complete';
}
