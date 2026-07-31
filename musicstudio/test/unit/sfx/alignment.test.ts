import { describe, expect, it } from 'vitest';

import {
  isDescendingWithinTolerance,
  isSeedAscendingWithinTieGroups,
  normalizeAlignmentScore,
  rankByAlignment,
} from '../../../domain/sfx/alignment';
import { SFX_ALIGNMENT_TIE_TOLERANCE } from '../../../domain/sfx/bounds';

/**
 * Alignment score normalisation and the ordering of Requirement 22.6.
 *
 * **Validates: Requirements 22.6, 22.7**
 *
 * The intransitivity of 22.6's comparator, and the decision taken about it, are documented in
 * `domain/sfx/alignment.ts`. These tests pin that decision: the primary order is score
 * descending, the seed decides inside a near-tie run, and a run spans at most the tolerance.
 */

function entry(alignmentScore: number, seed: number) {
  return { alignmentScore, seed };
}

function orderOf(...entries: readonly { alignmentScore: number; seed: number }[]) {
  return rankByAlignment(entries).map((ranked) => ranked.value.seed);
}

describe('normalisation (Requirement 22.7)', () => {
  it.each([0, 0.5, 1])('leaves %s untouched', (raw) => {
    expect(normalizeAlignmentScore(raw)).toBe(raw);
  });

  it('clamps rather than rejecting a score marginally outside the range', () => {
    // Floating-point accumulation can put a cosine similarity a hair over 1.0; that is a score
    // at the top of the range, not a malformed result.
    expect(normalizeAlignmentScore(1.0000000002)).toBe(1);
    expect(normalizeAlignmentScore(-0.0000000002)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'maps %s to the floor rather than throwing',
    (raw) => {
      expect(normalizeAlignmentScore(raw)).toBe(0);
    },
  );
});

describe('ordering (Requirement 22.6)', () => {
  it('sorts clearly different scores descending', () => {
    expect(orderOf(entry(0.2, 10), entry(0.9, 20), entry(0.5, 30))).toEqual([20, 30, 10]);
  });

  it('breaks a tie inside the tolerance by ascending seed', () => {
    // 0.5000 and 0.5005 are 0.0005 apart, inside 0.001, so the seeds decide — and the lower
    // seed wins even though its score is lower.
    expect(orderOf(entry(0.5, 77), entry(0.5005, 42))).toEqual([42, 77]);
  });

  it('does not apply the tie-break to scores further apart than the tolerance', () => {
    // 0.002 apart: score decides, so the higher score comes first despite the higher seed.
    expect(orderOf(entry(0.5, 1), entry(0.502, 99))).toEqual([99, 1]);
  });

  it('treats exactly the tolerance as a tie (22.6 says 이하)', () => {
    expect(orderOf(entry(0.5, 9), entry(0.5 + SFX_ALIGNMENT_TIE_TOLERANCE, 4))).toEqual([4, 9]);
  });

  it('is independent of the input order', () => {
    const entries = [entry(0.7, 5), entry(0.7003, 3), entry(0.2, 1), entry(0.9, 8)];
    const forward = rankByAlignment(entries).map((ranked) => ranked.value.seed);
    const backward = rankByAlignment([...entries].reverse()).map((ranked) => ranked.value.seed);

    expect(backward).toEqual(forward);
  });

  it('does not mutate its input', () => {
    const entries = [entry(0.2, 1), entry(0.9, 2)];
    rankByAlignment(entries);

    expect(entries.map((item) => item.seed)).toEqual([1, 2]);
  });

  it('assigns contiguous ranks from 0', () => {
    const ranked = rankByAlignment([entry(0.2, 1), entry(0.9, 2), entry(0.5, 3)]);

    expect(ranked.map((item) => item.rank)).toEqual([0, 1, 2]);
  });

  it('bounds a near-tie run at the tolerance, so a chain does not swallow the list', () => {
    // The intransitivity case: three scores each 0.0008 from the next, spanning 0.0016 overall.
    // A naive pairwise comparator has no defined answer here. The run stops at the first entry
    // more than the tolerance below the run's top, so 0.5000 starts a second group.
    const ranked = rankByAlignment([entry(0.5016, 3), entry(0.5008, 2), entry(0.5, 1)]);

    expect(ranked.map((item) => item.tieGroup)).toEqual([0, 0, 1]);
    // Inside group 0, seeds ascend; group 1 follows because its score is lower.
    expect(ranked.map((item) => item.value.seed)).toEqual([2, 3, 1]);
  });

  it('keeps the global invariant: no later entry outscores an earlier one by over the tolerance', () => {
    const ordered = rankByAlignment([
      entry(0.5016, 3),
      entry(0.5008, 2),
      entry(0.5, 1),
      entry(0.9, 9),
    ]).map((ranked) => ranked.value);

    expect(isDescendingWithinTolerance(ordered)).toBe(true);
  });

  it('keeps seeds ascending within every near-tie run', () => {
    const ranked = rankByAlignment([
      entry(0.4, 7),
      entry(0.4004, 2),
      entry(0.4008, 5),
      entry(0.1, 1),
    ]);

    expect(isSeedAscendingWithinTieGroups(ranked)).toBe(true);
  });

  it('ranks an empty list as an empty list', () => {
    expect(rankByAlignment([])).toEqual([]);
  });

  it('carries the whole subject through, not just the two ordering fields', () => {
    const ranked = rankByAlignment([
      { alignmentScore: 0.1, seed: 1, assetId: 'a' },
      { alignmentScore: 0.9, seed: 2, assetId: 'b' },
    ]);

    expect(ranked.map((item) => item.value.assetId)).toEqual(['b', 'a']);
  });
});
