/**
 * 좋아요 (Requirements 14.7, 14.8) — **Property 20**.
 *
 * > *For any* 인증된 사용자와 공개 `Audio_Asset` 조합에 대해, 좋아요를 2회 이상 요청해도
 * > 좋아요 수는 1만 유지된다.
 *
 * The property is held by the *shape of the data*, not by a check before the write. A like
 * is a member of a set keyed by (asset, account): adding a member twice leaves a set of
 * one, and there is no code path in which it does not. `0017_sharing.sql` states the same
 * thing as `PRIMARY KEY (asset_id, account_id)`, so a second writer — a retry, a
 * double-tapped button, two servers — cannot produce a second row either.
 *
 * That is deliberate belt-and-braces, and it is the difference between a property and a
 * test: an implementation that read the count, compared it and then inserted would satisfy
 * every single-request test and still double-count under concurrency, which is precisely
 * when a double-tap happens.
 *
 * ### Unliking
 *
 * Requirement 14 defines only the idempotent add. `unlike` is a **product addition**: the
 * inverse of a required operation, with no criterion behind it, included because a like a
 * user cannot take back is a worse product than the requirement implies and because
 * removing a set member is the same idempotence in the other direction. It is marked here
 * so a future criterion can contradict it knowingly rather than by accident.
 */

/** A like, as stored. The pair is the identity; the timestamp is only for display. */
export interface AssetLike {
  readonly assetId: string;
  readonly accountId: string;
  readonly likedAtMs: number;
}

export interface LikeOutcome {
  /** Requirement 14.8: the count after the request, which is what the caller shows. */
  readonly likeCount: number;
  readonly liked: boolean;
  /**
   * Whether this request moved anything.
   *
   * Requirement 14.8 says a repeat request returns the current state without changing the
   * count; a caller that logs, notifies or awards on a *new* like needs to tell the two
   * apart, and deriving it from a count it did not previously hold is not possible.
   */
  readonly changed: boolean;
}

/** The key a like set is indexed by. Stated once so no caller invents a second spelling. */
export function likeKey(assetId: string, accountId: string): string {
  // U+0000 as the separator, written as an escape: no identifier contains it, so no two
  // distinct pairs can collide into one key the way `a-b` + `c` and `a` + `b-c` would.
  return `${assetId}\u0000${accountId}`;
}

/**
 * Add a like to a set, idempotently.
 *
 * Returns a new set rather than mutating, so a caller cannot half-apply one: the count and
 * the membership come from the same value.
 */
export function applyLike(
  likes: ReadonlyMap<string, AssetLike>,
  like: AssetLike,
): { readonly likes: ReadonlyMap<string, AssetLike>; readonly outcome: LikeOutcome } {
  const key = likeKey(like.assetId, like.accountId);
  const existing = likes.get(key);

  // Requirement 14.8: the first like's timestamp stands. Overwriting it would make a
  // repeated request move the asset in a "recently liked" order — a change in state, from
  // an operation the criterion says changes nothing.
  const next = existing === undefined ? new Map(likes).set(key, like) : likes;

  return {
    likes: next,
    outcome: {
      likeCount: countFor(next, like.assetId),
      liked: true,
      changed: existing === undefined,
    },
  };
}

/** Remove a like, idempotently. See the header: a product addition, not a criterion. */
export function removeLike(
  likes: ReadonlyMap<string, AssetLike>,
  assetId: string,
  accountId: string,
): { readonly likes: ReadonlyMap<string, AssetLike>; readonly outcome: LikeOutcome } {
  const key = likeKey(assetId, accountId);
  if (!likes.has(key)) {
    return {
      likes,
      outcome: { likeCount: countFor(likes, assetId), liked: false, changed: false },
    };
  }

  const next = new Map(likes);
  next.delete(key);
  return {
    likes: next,
    outcome: { likeCount: countFor(next, assetId), liked: false, changed: true },
  };
}

export function hasLiked(
  likes: ReadonlyMap<string, AssetLike>,
  assetId: string,
  accountId: string,
): boolean {
  return likes.has(likeKey(assetId, accountId));
}

export function countFor(likes: ReadonlyMap<string, AssetLike>, assetId: string): number {
  let count = 0;
  for (const like of likes.values()) if (like.assetId === assetId) count += 1;
  return count;
}
