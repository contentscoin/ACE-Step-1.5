import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyLike,
  countFor,
  hasLiked,
  likeKey,
  removeLike,
  type AssetLike,
} from '../../domain/sharing/like';
import { createSharingService } from '../../services/sharing/sharing-service';
import {
  inMemoryLikeStore,
  inMemoryShareStore,
  shareableAsset,
} from '../support/sharing-harness';

/**
 * Property 20 — 좋아요 멱등 (design §10 Property 20).
 *
 * **Validates: Requirements 14.7, 14.8**
 *
 * > *For any* 인증된 사용자와 공개 `Audio_Asset` 조합에 대해, 좋아요를 2회 이상 요청해도
 * > 좋아요 수는 1만 유지된다.
 *
 * Checked at both levels it exists at, because they can fail independently:
 *
 * 1. **The domain** — a like is a set member, so applying it any number of times leaves one.
 * 2. **The service** — a repeated request through `Sharing_Service` moves neither the count
 *    nor the stored row, and reports `changed: false` so a caller can tell the second
 *    request from the first without having held the previous count.
 *
 * The generator interleaves *many users over many assets in arbitrary order*, rather than
 * repeating one request, because the failure mode worth catching is a counter kept beside
 * the set rather than derived from it — and such a counter is right for a single user and
 * wrong the moment two of them interleave.
 */

const ASSET_IDS = ['asset-a', 'asset-b', 'asset-c'];
const ACCOUNT_IDS = ['user-1', 'user-2', 'user-3', 'user-4'];

const arbLike: fc.Arbitrary<AssetLike> = fc.record({
  assetId: fc.constantFrom(...ASSET_IDS),
  accountId: fc.constantFrom(...ACCOUNT_IDS),
  likedAtMs: fc.integer({ min: 1_700_000_000_000, max: 1_700_000_100_000 }),
});

describe('Feature: ai-music-generation-service, Property 20: 동일한 (Audio_Asset, Account) 쌍에 좋아요를 몇 번 적용해도 좋아요는 정확히 1건으로 유지된다 (Requirements 14.7, 14.8) — the like set', () => {
  it('keeps exactly one like per (asset, account) however many times it is applied', () => {
    fc.assert(
      fc.property(fc.array(arbLike, { minLength: 1, maxLength: 60 }), (requests) => {
        let likes: ReadonlyMap<string, AssetLike> = new Map();
        for (const request of requests) {
          likes = applyLike(likes, request).likes;
        }

        // The property, stated directly: every distinct pair contributes exactly one.
        const distinct = new Set(requests.map((like) => likeKey(like.assetId, like.accountId)));
        expect(likes.size).toBe(distinct.size);

        for (const assetId of ASSET_IDS) {
          const expected = new Set(
            requests.filter((like) => like.assetId === assetId).map((like) => like.accountId),
          ).size;
          expect(countFor(likes, assetId)).toBe(expected);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('reports a repeat as unchanged, and never moves the count (14.8)', () => {
    fc.assert(
      fc.property(arbLike, fc.integer({ min: 2, max: 10 }), (like, repeats) => {
        let likes: ReadonlyMap<string, AssetLike> = new Map();
        const first = applyLike(likes, like);
        likes = first.likes;

        expect(first.outcome.changed).toBe(true);
        expect(first.outcome.likeCount).toBe(1);

        for (let attempt = 1; attempt < repeats; attempt += 1) {
          // A later timestamp on purpose: a repeat must not become a fresh like.
          const again = applyLike(likes, { ...like, likedAtMs: like.likedAtMs + attempt });
          likes = again.likes;
          expect(again.outcome.changed).toBe(false);
          expect(again.outcome.likeCount).toBe(1);
        }

        // 14.8 says the state does not change — including the timestamp the first like set.
        expect(likes.get(likeKey(like.assetId, like.accountId))?.likedAtMs).toBe(like.likedAtMs);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent in the other direction too', () => {
    fc.assert(
      fc.property(arbLike, fc.integer({ min: 1, max: 5 }), (like, repeats) => {
        let likes: ReadonlyMap<string, AssetLike> = new Map();
        likes = applyLike(likes, like).likes;

        for (let attempt = 0; attempt < repeats; attempt += 1) {
          const removed = removeLike(likes, like.assetId, like.accountId);
          likes = removed.likes;
          expect(removed.outcome.changed).toBe(attempt === 0);
          expect(removed.outcome.likeCount).toBe(0);
        }
        expect(hasLiked(likes, like.assetId, like.accountId)).toBe(false);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property 20: 좋아요 멱등 — through Sharing_Service', () => {
  function service() {
    const assets = inMemoryShareStore(
      ASSET_IDS.map((id) =>
        shareableAsset({ id, shareToken: `token-${id}`, publishedAtMs: 1_700_000_000_000 }),
      ),
    );
    const likes = inMemoryLikeStore();
    return { likes, sharing: createSharingService({ assets, likes }) };
  }

  it('stores one row per (asset, account) across an arbitrary request sequence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbLike, { minLength: 1, maxLength: 40 }), async (requests) => {
        const { likes, sharing } = service();

        for (const request of requests) {
          await sharing.like(request.assetId, request.accountId);
        }

        const distinct = new Set(requests.map((like) => likeKey(like.assetId, like.accountId)));
        expect(likes.rows.size).toBe(distinct.size);

        for (const assetId of ASSET_IDS) {
          const expected = new Set(
            requests.filter((like) => like.assetId === assetId).map((like) => like.accountId),
          ).size;
          expect(await likes.countFor(assetId)).toBe(expected);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('answers a repeated like with the same count and changed: false', async () => {
    await fc.assert(
      fc.asyncProperty(arbLike, fc.integer({ min: 2, max: 6 }), async (like, repeats) => {
        const { sharing } = service();

        const first = await sharing.like(like.assetId, like.accountId);
        expect(first).toEqual({ likeCount: 1, liked: true, changed: true });

        for (let attempt = 1; attempt < repeats; attempt += 1) {
          expect(await sharing.like(like.assetId, like.accountId)).toEqual({
            likeCount: 1,
            liked: true,
            changed: false,
          });
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
