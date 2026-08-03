import { describe, expect, it } from 'vitest';

import { LIBRARY_PAGE_SIZE_MAX } from '../../../domain/library/bounds';
import {
  applyLibraryQuery,
  libraryQueryViolations,
  matchesSearch,
  toLibraryQuery,
} from '../../../domain/library/query';
import { assetRecord } from '../../support/library-harness';

/** Requirements 11.1-11.4, 11.7, 11.12. */

function query(overrides: Partial<Parameters<typeof toLibraryQuery>[0]> = {}) {
  return toLibraryQuery({ ownerId: 'owner-1', ...overrides });
}

const ASSETS = [
  assetRecord({ id: 'a', name: 'Alpha', createdAtMs: 3_000, playCount: 5 }),
  assetRecord({ id: 'b', name: 'bravo', createdAtMs: 1_000, playCount: 50 }),
  assetRecord({ id: 'c', name: 'Charlie', createdAtMs: 2_000, playCount: 0, assetKind: 'sfx' }),
];

describe('library listing (Requirements 11.1, 11.4, 11.7, 11.12)', () => {
  it('returns only the requester s assets, newest first', () => {
    const foreign = assetRecord({ id: 'x', ownerId: 'owner-2', createdAtMs: 9_000 });
    const page = applyLibraryQuery([...ASSETS, foreign], query());
    expect(page.assets.map((asset) => asset.id)).toEqual(['a', 'c', 'b']);
  });

  it('excludes deleted assets (11.7)', () => {
    const deleted = assetRecord({ id: 'd', isDeleted: true, createdAtMs: 9_000 });
    const page = applyLibraryQuery([...ASSETS, deleted], query());
    expect(page.assets.map((asset) => asset.id)).not.toContain('d');
  });

  it('sorts by title, case-blind and ascending (11.4)', () => {
    const page = applyLibraryQuery(ASSETS, query({ sortKey: 'title' }));
    expect(page.assets.map((asset) => asset.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by play count, most played first (11.4)', () => {
    const page = applyLibraryQuery(ASSETS, query({ sortKey: 'play_count' }));
    expect(page.assets.map((asset) => asset.id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by Asset_Kind (11.12)', () => {
    const page = applyLibraryQuery(ASSETS, query({ assetKind: 'sfx' }));
    expect(page.assets.map((asset) => asset.id)).toEqual(['c']);
  });

  it('breaks ties by identifier so the order is total', () => {
    const tied = [
      assetRecord({ id: 'z', createdAtMs: 1_000 }),
      assetRecord({ id: 'y', createdAtMs: 1_000 }),
    ];
    expect(applyLibraryQuery(tied, query()).assets.map((a) => a.id)).toEqual(['y', 'z']);
  });
});

describe('search (Requirement 11.3)', () => {
  const asset = assetRecord({
    name: 'Night Drive',
    caption: 'a synthwave cruise',
    lyrics: 'neon rain on the windshield',
    tags: ['lo-fi', 'chill'],
  });

  it.each([
    ['title', 'night'],
    ['caption', 'synthwave'],
    ['lyrics', 'neon'],
    ['tag', 'lo-fi'],
  ])('matches on %s', (_field, term) => {
    expect(matchesSearch(asset, term)).toBe(true);
  });

  it('matches a substring, not just a whole word', () => {
    expect(matchesSearch(asset, 'wave')).toBe(true);
  });

  it('is case-blind on both sides', () => {
    expect(matchesSearch(asset, 'NIGHT')).toBe(true);
  });

  it('does not match text that is absent', () => {
    expect(matchesSearch(asset, 'accordion')).toBe(false);
  });

  it('filters a listing', () => {
    const page = applyLibraryQuery([asset, ...ASSETS], query({ search: 'neon' }));
    expect(page.assets).toHaveLength(1);
  });
});

describe('pagination (Requirement 11.2)', () => {
  const many = Array.from({ length: 120 }, (_, index) =>
    assetRecord({ id: `asset-${String(index).padStart(3, '0')}`, createdAtMs: index }),
  );

  it('caps a page at 50 and returns a cursor', () => {
    const page = applyLibraryQuery(many, query());
    expect(page.assets).toHaveLength(LIBRARY_PAGE_SIZE_MAX);
    expect(page.nextCursor).not.toBeNull();
  });

  it('walks the whole set without repeating or skipping', () => {
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof applyLibraryQuery>['nextCursor'];

    for (let guard = 0; guard < 10; guard += 1) {
      const page = applyLibraryQuery(many, query({ cursor }));
      seen.push(...page.assets.map((asset) => asset.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(many.length);
    expect(new Set(seen).size).toBe(many.length);
  });

  it('spends the cursor on the last page', () => {
    const page = applyLibraryQuery(many.slice(0, 10), query());
    expect(page.nextCursor).toBeNull();
  });

  it('does not repeat a page when the cursor s own row was deleted between requests', () => {
    const first = applyLibraryQuery(many, query({ pageSize: 10 }));
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();

    // The row the cursor names is gone; the next page must still start after it.
    const without = many.filter((asset) => asset.id !== cursor?.id);
    const second = applyLibraryQuery(without, query({ pageSize: 10, cursor }));

    const firstIds = new Set(first.assets.map((asset) => asset.id));
    expect(second.assets.some((asset) => firstIds.has(asset.id))).toBe(false);
  });
});

describe('query validation', () => {
  it('rejects a page size past the ceiling', () => {
    const violations = libraryQueryViolations({ ownerId: 'owner-1', pageSize: 51 });
    expect(violations[0]?.violation).toBe('page_size_invalid');
  });

  it('rejects an unknown sort key and an unknown Asset_Kind', () => {
    expect(
      libraryQueryViolations({ ownerId: 'owner-1', sortKey: 'loudness' })[0]?.violation,
    ).toBe('sort_key_unknown');
    expect(
      libraryQueryViolations({ ownerId: 'owner-1', assetKind: 'podcast' })[0]?.violation,
    ).toBe('asset_kind_unknown');
  });

  it('rejects a cursor issued for a different order', () => {
    const violations = libraryQueryViolations({
      ownerId: 'owner-1',
      sortKey: 'title',
      cursor: { sortKey: 'created_at', value: 1, id: 'a' },
    });
    expect(violations[0]?.violation).toBe('cursor_sort_key_mismatch');
  });

  it('accepts a cursor issued for the order being asked for', () => {
    expect(
      libraryQueryViolations({
        ownerId: 'owner-1',
        sortKey: 'title',
        cursor: { sortKey: 'title', value: 'a', id: 'a' },
      }),
    ).toEqual([]);
  });

  it('defaults to newest-first, 50 a page, every kind', () => {
    const resolved = toLibraryQuery({ ownerId: 'owner-1' });
    expect(resolved).toMatchObject({
      sortKey: 'created_at',
      pageSize: LIBRARY_PAGE_SIZE_MAX,
      assetKind: null,
      search: null,
    });
  });
});
