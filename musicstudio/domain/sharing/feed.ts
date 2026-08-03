/**
 * The discovery feed: what is in it, in what order, and where the next page starts.
 *
 * Requirements 14.5, 14.6, 14.10, and Requirement 16.9's exclusion. Pure over a summary
 * record, the same arrangement `domain/library/query.ts` uses and for the same reason: an
 * in-memory store and a SQL one implement one specification instead of each deriving the
 * conjunction themselves.
 *
 * ### The four conditions are ANDed here, not by the caller
 *
 * An asset is in the feed when it is **published**, **not soft-deleted** (14.5) and **not
 * excluded by review** (16.9). Each comes from a different requirement and a different
 * owner, and any caller assembling them itself is one `AND` away from publishing a withheld
 * asset. `applyFeedQuery` is the only place they meet.
 *
 * Requirement 14.10 asks for identical behaviour across all six Asset_Kinds. That is not a
 * branch here — it is the *absence* of one. Nothing in this module reads `assetKind` except
 * the filter 14.6 asks for, so a kind cannot behave differently by omission.
 */

import { isAssetKind, type AssetKind } from '../asset-kind';
import { isExcludedFromDiscoveryFeed, type AssetReviewState } from '../moderation/review-state';
import { normaliseTag } from '../library/tags';
import {
  FEED_PAGE_SIZE_DEFAULT,
  FEED_SORT_KEY_DEFAULT,
  isFeedPageSize,
  isFeedSortKey,
  type FeedSortKey,
} from './bounds';

/** What a feed needs to filter, order and display. Not the whole `Audio_Asset`. */
export interface FeedAssetSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly assetKind: AssetKind;
  readonly caption: string;
  readonly tags: readonly string[];
  /** Requirement 14.6's 장르. Normalised the way tags are. */
  readonly genres: readonly string[];
  readonly playCount: number;
  readonly likeCount: number;
  readonly isDeleted: boolean;
  readonly reviewState: AssetReviewState;
  /** `null` while the asset is private — Requirement 14.1's default state. */
  readonly publishedAtMs: number | null;
}

export interface FeedQuery {
  readonly pageSize: number;
  readonly sortKey: FeedSortKey;
  /** `null` means every kind. */
  readonly assetKind: AssetKind | null;
  readonly genre: string | null;
  readonly tag: string | null;
  readonly cursor: FeedCursor | null;
}

export interface FeedCursor {
  readonly sortKey: FeedSortKey;
  readonly value: number;
  readonly id: string;
}

export type FeedQueryViolationCode =
  | 'page_size_invalid'
  | 'sort_key_unknown'
  | 'asset_kind_unknown'
  | 'cursor_sort_key_mismatch';

export interface FeedQueryViolation {
  readonly field: string;
  readonly violation: FeedQueryViolationCode;
  readonly expected?: string;
  readonly actual?: string;
}

export interface FeedQueryInput {
  readonly pageSize?: number;
  readonly sortKey?: string;
  readonly assetKind?: string | null;
  readonly genre?: string | null;
  readonly tag?: string | null;
  readonly cursor?: FeedCursor | null;
}

export function feedQueryViolations(input: FeedQueryInput): FeedQueryViolation[] {
  const violations: FeedQueryViolation[] = [];

  if (input.pageSize !== undefined && !isFeedPageSize(input.pageSize)) {
    violations.push({
      field: 'pageSize',
      violation: 'page_size_invalid',
      expected: '1..50',
      actual: String(input.pageSize),
    });
  }
  if (input.sortKey !== undefined && !isFeedSortKey(input.sortKey)) {
    violations.push({ field: 'sortKey', violation: 'sort_key_unknown', actual: String(input.sortKey) });
  }
  if (input.assetKind !== undefined && input.assetKind !== null && !isAssetKind(input.assetKind)) {
    violations.push({
      field: 'assetKind',
      violation: 'asset_kind_unknown',
      actual: String(input.assetKind),
    });
  }

  // As in the library: a cursor is only meaningful for the order it was issued for.
  const sortKey = isFeedSortKey(input.sortKey) ? input.sortKey : FEED_SORT_KEY_DEFAULT;
  if (input.cursor != null && input.cursor.sortKey !== sortKey) {
    violations.push({
      field: 'cursor',
      violation: 'cursor_sort_key_mismatch',
      expected: sortKey,
      actual: input.cursor.sortKey,
    });
  }

  return violations;
}

export function toFeedQuery(input: FeedQueryInput = {}): FeedQuery {
  const genre = input.genre == null ? null : normaliseTag(input.genre);
  const tag = input.tag == null ? null : normaliseTag(input.tag);
  return {
    pageSize: input.pageSize ?? FEED_PAGE_SIZE_DEFAULT,
    sortKey: isFeedSortKey(input.sortKey) ? input.sortKey : FEED_SORT_KEY_DEFAULT,
    assetKind: isAssetKind(input.assetKind) ? input.assetKind : null,
    genre: genre === '' ? null : genre,
    tag: tag === '' ? null : tag,
    cursor: input.cursor ?? null,
  };
}

/**
 * Requirement 14.5's membership test, as one predicate.
 *
 * Exported because the Sharing_Service answers "is this asset publicly visible" for three
 * other services' ports (`services/playback`, `services/moderation`, `services/voice`), and
 * that answer must be the same rule the feed uses. Two spellings of "public" is exactly the
 * drift that leaves a withheld asset streamable while it is invisible in the feed.
 */
export function isDiscoverable(asset: FeedAssetSummary): boolean {
  return (
    asset.publishedAtMs !== null &&
    !asset.isDeleted &&
    !isExcludedFromDiscoveryFeed(asset.reviewState)
  );
}

export function feedSortValue(asset: FeedAssetSummary, sortKey: FeedSortKey): number {
  switch (sortKey) {
    case 'published_at':
      return asset.publishedAtMs ?? 0;
    case 'play_count':
      return asset.playCount;
    case 'like_count':
      return asset.likeCount;
  }
}

/** Every order descends — newest, most played, most liked — with the id as the tie-break. */
export function compareFeedAssets(
  left: FeedAssetSummary,
  right: FeedAssetSummary,
  sortKey: FeedSortKey,
): number {
  const leftValue = feedSortValue(left, sortKey);
  const rightValue = feedSortValue(right, sortKey);
  if (leftValue !== rightValue) return leftValue < rightValue ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface FeedPage {
  readonly assets: readonly FeedAssetSummary[];
  readonly nextCursor: FeedCursor | null;
}

export function applyFeedQuery(
  assets: readonly FeedAssetSummary[],
  query: FeedQuery,
): FeedPage {
  const matching = assets
    .filter(isDiscoverable) // Requirements 14.5, 16.9
    .filter((asset) => query.assetKind === null || asset.assetKind === query.assetKind) // 14.6
    .filter((asset) => query.genre === null || asset.genres.includes(query.genre)) // 14.6
    .filter((asset) => query.tag === null || asset.tags.includes(query.tag)) // 14.6
    .sort((left, right) => compareFeedAssets(left, right, query.sortKey));

  const start = query.cursor === null ? 0 : seekPastCursor(matching, query.cursor, query.sortKey);
  const page = matching.slice(start, start + query.pageSize);
  const last = page.at(-1);
  const exhausted = last === undefined || start + page.length >= matching.length;

  return {
    assets: page,
    nextCursor: exhausted
      ? null
      : { sortKey: query.sortKey, value: feedSortValue(last, query.sortKey), id: last.id },
  };
}

/** By identifier, not by index — see `domain/library/query.ts` for why. */
function seekPastCursor(
  sorted: readonly FeedAssetSummary[],
  cursor: FeedCursor,
  sortKey: FeedSortKey,
): number {
  const index = sorted.findIndex((asset) => asset.id === cursor.id);
  if (index >= 0) return index + 1;

  const position = sorted.findIndex((asset) => {
    const value = feedSortValue(asset, sortKey);
    return value === cursor.value ? asset.id > cursor.id : value < cursor.value;
  });
  return position < 0 ? sorted.length : position;
}
