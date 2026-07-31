import { describe, expect, it } from 'vitest';

import {
  PACK_CATEGORY_COUNT,
  PACK_CUE_COUNT,
  PACK_CUE_PAIR_COUNT,
  PACK_EXPORT_FILE_COUNT,
  PACK_LOOP_COUNT,
  PACK_ONE_SHOT_COUNT,
  cueLengthRangeSeconds,
  isCueDefaultVolume,
  isCueLengthSeconds,
  isPackDescription,
  isPackName,
} from '../../../domain/sound-pack/bounds';
import {
  CUE_CATEGORIES,
  CUE_NAMES,
  LOOP_CUE_NAMES,
  ONE_SHOT_CUE_NAMES,
  SEMANTIC_CUES,
  cueByName,
  cueContractDocument,
  cuesInCategory,
  isCueName,
  isLoopCue,
  missingCueNames,
  unknownCueNames,
} from '../../../domain/sound-pack/taxonomy';

/**
 * The Semantic_Cue taxonomy against Requirement 24's own counts.
 *
 * These are the assertions that make the taxonomy *checkable* rather than merely present: the
 * counts of 24.1, 24.4 and 24.5 are stated in the requirement and are the thing a transcription
 * error breaks, and a 79th cue or a duplicated name would otherwise be invisible until a pack
 * failed 24.2 in production.
 */

describe('the taxonomy matches Requirement 24\'s counts', () => {
  it('has 78 cues across 13 categories', () => {
    expect(SEMANTIC_CUES).toHaveLength(PACK_CUE_COUNT);
    expect(CUE_CATEGORIES).toHaveLength(PACK_CATEGORY_COUNT);
    expect(CUE_NAMES).toHaveLength(PACK_CUE_COUNT);
  });

  it('names every cue exactly once', () => {
    expect(new Set(CUE_NAMES).size).toBe(PACK_CUE_COUNT);
  });

  it('puts every cue in a declared category, and leaves no category empty', () => {
    for (const cue of SEMANTIC_CUES) {
      expect(CUE_CATEGORIES).toContain(cue.category);
    }
    for (const category of CUE_CATEGORIES) {
      expect(cuesInCategory(category).length).toBeGreaterThan(0);
    }
  });

  it('has 6 loops and 72 one-shots, and the loops are the ones Requirement 24.5 names', () => {
    expect(LOOP_CUE_NAMES).toHaveLength(PACK_LOOP_COUNT);
    expect(ONE_SHOT_CUE_NAMES).toHaveLength(PACK_ONE_SHOT_COUNT);
    expect([...LOOP_CUE_NAMES]).toEqual([
      'loading',
      'processing',
      'recording',
      'connecting',
      'scanning',
      'streaming',
    ]);
    // The loop flag is derived from the category, so the two can never disagree.
    for (const name of LOOP_CUE_NAMES) expect(isLoopCue(name)).toBe(true);
    for (const name of ONE_SHOT_CUE_NAMES) expect(isLoopCue(name)).toBe(false);
    expect(cuesInCategory('loops').map((cue) => cue.name)).toEqual([...LOOP_CUE_NAMES]);
  });

  it('gives every cue a default volume inside design §8.3\'s range', () => {
    for (const cue of SEMANTIC_CUES) {
      expect(isCueDefaultVolume(cue.defaultVolume)).toBe(true);
    }
  });

  it('gives every cue an intent and at least one misuse boundary (24.19)', () => {
    const document = cueContractDocument();
    expect(document).toHaveLength(PACK_CUE_COUNT);
    for (const contract of document) {
      expect(contract.intent.length).toBeGreaterThan(0);
      expect(contract.misuseBoundaries.length).toBeGreaterThanOrEqual(1);
      for (const boundary of contract.misuseBoundaries) {
        expect(boundary.length).toBeGreaterThan(0);
      }
    }
  });

  it('derives 3003 pairs and 156 export files from the cue count', () => {
    expect(PACK_CUE_PAIR_COUNT).toBe(3_003);
    expect(PACK_CUE_PAIR_COUNT).toBe((PACK_CUE_COUNT * (PACK_CUE_COUNT - 1)) / 2);
    expect(PACK_EXPORT_FILE_COUNT).toBe(156);
  });
});

describe('membership and completeness helpers (Requirements 24.2, 24.3)', () => {
  it('recognises every taxonomy name and nothing else', () => {
    for (const name of CUE_NAMES) expect(isCueName(name)).toBe(true);
    expect(isCueName('kerplunk')).toBe(false);
    expect(isCueName(42)).toBe(false);
    expect(cueByName('hover')?.category).toBe('input');
    expect(cueByName('kerplunk')).toBeUndefined();
  });

  it('reports missing cues in taxonomy order, so two runs report the same list', () => {
    const present = CUE_NAMES.filter((name) => name !== 'select' && name !== 'hover');

    // Taxonomy order, not the order they were noticed: `hover` precedes `select`.
    expect(missingCueNames(present)).toEqual(['hover', 'select']);
    expect(missingCueNames(CUE_NAMES)).toEqual([]);
    expect(missingCueNames([])).toHaveLength(PACK_CUE_COUNT);
  });

  it('reports unknown names once each, in the order they appeared', () => {
    expect(unknownCueNames(['hover', 'zzz', 'yyy', 'zzz'])).toEqual(['zzz', 'yyy']);
    expect(unknownCueNames(CUE_NAMES)).toEqual([]);
  });
});

describe('the bounds of Requirements 24.1, 24.4, 24.5', () => {
  it('accepts a 1–60 character name and a 1–200 character description', () => {
    expect(isPackName('x')).toBe(true);
    expect(isPackName('x'.repeat(60))).toBe(true);
    expect(isPackName('')).toBe(false);
    expect(isPackName('x'.repeat(61))).toBe(false);
    expect(isPackName(undefined)).toBe(false);

    expect(isPackDescription('y')).toBe(true);
    expect(isPackDescription('y'.repeat(200))).toBe(true);
    expect(isPackDescription('')).toBe(false);
    expect(isPackDescription('y'.repeat(201))).toBe(false);
  });

  it('picks the range from the loop flag, inclusive at both ends', () => {
    expect(cueLengthRangeSeconds(false)).toEqual({ min: 0.05, max: 1.5 });
    expect(cueLengthRangeSeconds(true)).toEqual({ min: 0.5, max: 4.0 });

    expect(isCueLengthSeconds(0.05, false)).toBe(true);
    expect(isCueLengthSeconds(1.5, false)).toBe(true);
    expect(isCueLengthSeconds(0.049, false)).toBe(false);
    expect(isCueLengthSeconds(1.501, false)).toBe(false);

    expect(isCueLengthSeconds(0.5, true)).toBe(true);
    expect(isCueLengthSeconds(4.0, true)).toBe(true);
    expect(isCueLengthSeconds(0.49, true)).toBe(false);
    expect(isCueLengthSeconds(4.01, true)).toBe(false);

    // A one-shot's range is *not* a loop's: 0.2 s is fine as a one-shot and too short as a loop.
    expect(isCueLengthSeconds(0.2, false)).toBe(true);
    expect(isCueLengthSeconds(0.2, true)).toBe(false);
  });

  it('rejects a non-finite length rather than admitting it', () => {
    expect(isCueLengthSeconds(Number.NaN, false)).toBe(false);
    expect(isCueLengthSeconds(Number.POSITIVE_INFINITY, true)).toBe(false);
    expect(isCueDefaultVolume(Number.NaN)).toBe(false);
    expect(isCueDefaultVolume(1.01)).toBe(false);
    expect(isCueDefaultVolume(-0.01)).toBe(false);
  });
});
