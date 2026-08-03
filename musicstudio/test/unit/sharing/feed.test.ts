import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ASSET_REVIEW_STATES } from '../../../domain/moderation/review-state';
import {
  applyFeedQuery,
  feedQueryViolations,
  isDiscoverable,
  toFeedQuery,
} from '../../../domain/sharing/feed';
import { shareableAsset } from '../../support/sharing-harness';

/**
 * The discovery feed.
 *
 * **Validates: Requirements 14.5, 14.6, 14.10, 16.9**
 *
 * Task 5.3's acceptance criterion — "탐색 피드 비공개 자산 미노출 확인" — is the first block.
 * It is checked three ways because there are three ways to not be in the feed and they come
 * from three different requirements: never published (14.1/14.5), soft-deleted (14.5), and
 * excluded by review (16.9). An implementation can honour any two and miss the third.
 */

const PUBLISHED = 1_700_000_000_000;

function published(overrides: Parameters<typeof shareableAsset>[0] = {}) {
  return shareableAsset({ publishedAtMs: PUBLISHED, shareToken: 'token', ...overrides });
}

describe('what is in the feed (Requirements 14.5, 16.9)', () => {
  it('shows a published, undeleted, unreported asset', () => {
    const page = applyFeedQuery([published()], toFeedQuery());
    expect(page.assets.map((asset) => asset.id)).toEqual(['asset-a']);
  });

  it('hides a private asset', () => {
    const page = applyFeedQuery([shareableAsset({ id: 'x' })], toFeedQuery());
    expect(page.assets).toEqual([]);
  });

  it('hides a soft-deleted asset even while it is published', () => {
    const page = applyFeedQuery([published({ isDeleted: true })], toFeedQuery());
    expect(page.assets).toEqual([]);
  });

  it('hides an asset under review or withheld (16.9)', () => {
    for (const reviewState of ['under_review', 'withheld'] as const) {
      expect(applyFeedQuery([published({ reviewState })], toFeedQuery()).assets).toEqual([]);
    }
  });

  it('shows an asset a review cleared', () => {
    const page = applyFeedQuery([published({ reviewState: 'cleared' })], toFeedQuery());
    expect(page.assets).toHaveLength(1);
  });

  it('agrees with isDiscoverable on every review state', () => {
    // The predicate and the query must not disagree — the query is the predicate plus
    // filters, and three other services ask the predicate directly.
    for (const reviewState of ASSET_REVIEW_STATES) {
      const asset = published({ reviewState });
      expect(applyFeedQuery([asset], toFeedQuery()).assets.length).toBe(
        isDiscoverable(asset) ? 1 : 0,
      );
    }
  });
});

describe('feed filters (Requirement 14.6)', () => {
  const ASSETS = [
    published({ id: 'a', assetKind: 'song', genres: ['lo-fi'], tags: ['chill'], likeCount: 5 }),
    published({ id: 'b', assetKind: 'sfx', genres: ['ambient'], tags: ['chill'], likeCount: 1 }),
    published({ id: 'c', assetKind: 'song', genres: ['lo-fi', 'jazz'], tags: [], likeCount: 9 }),
  ];

  it('filters by Asset_Kind', () => {
    const page = applyFeedQuery(ASSETS, toFeedQuery({ assetKind: 'sfx' }));
    expect(page.assets.map((asset) => asset.id)).toEqual(['b']);
  });

  it('filters by genre, case-blind through normalisation', () => {
    const page = applyFeedQuery(ASSETS, toFeedQuery({ genre: '  LO-FI ' }));
    expect(page.assets.map((asset) => asset.id).sort()).toEqual(['a', 'c']);
  });

  it('filters by tag', () => {
    const page = applyFeedQuery(ASSETS, toFeedQuery({ tag: 'chill' }));
    expect(page.assets.map((asset) => asset.id).sort()).toEqual(['a', 'b']);
  });

  it('combines filters conjunctively', () => {
    const page = applyFeedQuery(ASSETS, toFeedQuery({ assetKind: 'song', tag: 'chill' }));
    expect(page.assets.map((asset) => asset.id)).toEqual(['a']);
  });

  it('treats an empty filter as no filter', () => {
    expect(toFeedQuery({ genre: '   ', tag: '' })).toMatchObject({ genre: null, tag: null });
  });
});

describe('feed ordering and paging (Requirement 14.5)', () => {
  const ASSETS = [
    published({ id: 'a', publishedAtMs: 3_000, playCount: 1, likeCount: 30 }),
    published({ id: 'b', publishedAtMs: 1_000, playCount: 50, likeCount: 2 }),
    published({ id: 'c', publishedAtMs: 2_000, playCount: 10, likeCount: 90 }),
  ];

  it('defaults to newest publication first', () => {
    expect(applyFeedQuery(ASSETS, toFeedQuery()).assets.map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });

  it('orders by play count and by like count when asked', () => {
    expect(
      applyFeedQuery(ASSETS, toFeedQuery({ sortKey: 'play_count' })).assets.map((a) => a.id),
    ).toEqual(['b', 'c', 'a']);
    expect(
      applyFeedQuery(ASSETS, toFeedQuery({ sortKey: 'like_count' })).assets.map((a) => a.id),
    ).toEqual(['c', 'a', 'b']);
  });

  it('pages by cursor without repeating or skipping', () => {
    const first = applyFeedQuery(ASSETS, toFeedQuery({ pageSize: 2 }));
    expect(first.assets.map((a) => a.id)).toEqual(['a', 'c']);
    expect(first.nextCursor).not.toBeNull();

    const second = applyFeedQuery(ASSETS, toFeedQuery({ pageSize: 2, cursor: first.nextCursor }));
    expect(second.assets.map((a) => a.id)).toEqual(['b']);
    expect(second.nextCursor).toBeNull();
  });

  it('survives the cursor row being unpublished between pages', () => {
    const first = applyFeedQuery(ASSETS, toFeedQuery({ pageSize: 1 }));
    const remaining = ASSETS.filter((asset) => asset.id !== 'a');

    const second = applyFeedQuery(
      remaining,
      toFeedQuery({ pageSize: 2, cursor: first.nextCursor }),
    );
    expect(second.assets.map((a) => a.id)).toEqual(['c', 'b']);
  });

  it('refuses a cursor issued for a different order', () => {
    const first = applyFeedQuery(ASSETS, toFeedQuery({ pageSize: 1 }));
    const violations = feedQueryViolations({ sortKey: 'like_count', cursor: first.nextCursor });
    expect(violations.map((violation) => violation.violation)).toEqual([
      'cursor_sort_key_mismatch',
    ]);
  });

  it('refuses a page size outside the bound and an unknown order', () => {
    expect(feedQueryViolations({ pageSize: 0 })[0]?.violation).toBe('page_size_invalid');
    expect(feedQueryViolations({ pageSize: 51 })[0]?.violation).toBe('page_size_invalid');
    expect(feedQueryViolations({ sortKey: 'loudest' })[0]?.violation).toBe('sort_key_unknown');
    expect(feedQueryViolations({ assetKind: 'podcast' })[0]?.violation).toBe('asset_kind_unknown');
  });
});

describe('feed invariants', () => {
  const arbAsset = fc.record({
    id: fc.string({ minLength: 1, maxLength: 6 }),
    publishedAtMs: fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
    isDeleted: fc.boolean(),
    reviewState: fc.constantFrom(...ASSET_REVIEW_STATES),
    likeCount: fc.integer({ min: 0, max: 100 }),
  });

  it('never returns anything isDiscoverable rejects', () => {
    fc.assert(
      fc.property(fc.uniqueArray(arbAsset, { selector: (a) => a.id, maxLength: 30 }), (rows) => {
        const assets = rows.map((row) => published(row));
        for (const asset of applyFeedQuery(assets, toFeedQuery()).assets) {
          expect(isDiscoverable(asset)).toBe(true);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('walks every discoverable asset exactly once across pages', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbAsset, { selector: (a) => a.id, maxLength: 30 }),
        fc.integer({ min: 1, max: 5 }),
        (rows, pageSize) => {
          const assets = rows.map((row) => published(row));
          const seen: string[] = [];

          let cursor = null as ReturnType<typeof applyFeedQuery>['nextCursor'];
          for (;;) {
            const page = applyFeedQuery(assets, toFeedQuery({ pageSize, cursor }));
            seen.push(...page.assets.map((asset) => asset.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
          }

          const expected = assets.filter(isDiscoverable).map((asset) => asset.id);
          expect([...seen].sort()).toEqual([...expected].sort());
          expect(new Set(seen).size).toBe(seen.length);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
