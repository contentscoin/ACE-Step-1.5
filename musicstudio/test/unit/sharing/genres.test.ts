import { describe, expect, it } from 'vitest';

import {
  ASSET_GENRE_COUNT_MAX,
  ASSET_GENRE_MAX_LENGTH,
} from '../../../domain/sharing/bounds';
import { isStorableGenre, normaliseGenre, parseGenres } from '../../../domain/sharing/genres';

/**
 * Genre parsing.
 *
 * **Validates: Requirements 14.6, 3.4**
 *
 * The engine reports genres as free text (Requirement 3.4) and Requirement 14.6 filters by
 * them, so something has to turn a string into facets. The tests that matter are the ones
 * about *not* splitting: a genre with a space in it is one genre, and cutting `hip hop` in
 * half produces two labels nobody will ever filter by and one the user never saw.
 */

describe('parseGenres (Requirements 3.4, 14.6)', () => {
  it('splits on the separators the engine emits', () => {
    expect(parseGenres('lo-fi, jazz; ambient / downtempo')).toEqual([
      'lo-fi',
      'jazz',
      'ambient',
      'downtempo',
    ]);
  });

  it('keeps a multi-word genre whole', () => {
    expect(parseGenres('hip hop, drum and bass')).toEqual(['hip hop', 'drum and bass']);
  });

  it('normalises case and surrounding space', () => {
    expect(parseGenres('  LO-FI ,  Jazz  ')).toEqual(['lo-fi', 'jazz']);
  });

  it('drops duplicates that normalisation created', () => {
    expect(parseGenres('Lo-Fi, lo-fi, LO-FI')).toEqual(['lo-fi']);
  });

  it('returns nothing for absent or empty input', () => {
    expect(parseGenres(null)).toEqual([]);
    expect(parseGenres(undefined)).toEqual([]);
    expect(parseGenres('   ,  ;  ')).toEqual([]);
  });

  it('drops an over-long label rather than truncating it', () => {
    // A truncated genre is a label nobody wrote and nobody will filter by.
    const long = 'x'.repeat(ASSET_GENRE_MAX_LENGTH + 1);
    expect(parseGenres(`jazz, ${long}, lo-fi`)).toEqual(['jazz', 'lo-fi']);
  });

  it('keeps a label exactly at the ceiling', () => {
    const exact = 'x'.repeat(ASSET_GENRE_MAX_LENGTH);
    expect(parseGenres(exact)).toEqual([exact]);
  });

  it('stops at the per-asset cap, keeping the engine s order', () => {
    const reported = Array.from({ length: ASSET_GENRE_COUNT_MAX + 5 }, (_, i) => `g${String(i)}`);
    const parsed = parseGenres(reported.join(','));

    expect(parsed).toHaveLength(ASSET_GENRE_COUNT_MAX);
    expect(parsed[0]).toBe('g0');
  });
});

describe('isStorableGenre', () => {
  it('accepts only what parseGenres produces', () => {
    for (const genre of parseGenres('Lo-Fi, hip hop, JAZZ')) {
      expect(isStorableGenre(genre)).toBe(true);
    }
  });

  it('refuses anything the DDL s normalised CHECK would refuse', () => {
    for (const value of ['Lo-Fi', ' jazz', 'jazz ', '', 'x'.repeat(41), 42, null]) {
      expect(isStorableGenre(value)).toBe(false);
    }
  });

  it('normalises the same way the tag rule does', () => {
    expect(normaliseGenre('  Lo-Fi  ')).toBe('lo-fi');
  });
});
