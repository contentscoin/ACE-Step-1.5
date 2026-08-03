/**
 * Sharing's stated numbers (Requirements 14.2, 14.5, 14.6, 14.11).
 *
 * One module for `db/migrations/0017_sharing.sql` to mirror, the way
 * `domain/library/bounds.ts` is mirrored by `0016_library.sql`.
 * `test/unit/sharing/schema-parity.test.ts` fails if the two drift.
 */

/**
 * Requirement 14.2: "추측이 어려운 공개 링크".
 *
 * The criterion names a property, not a length, so the length is derived from the property.
 * A share token is the *only* thing standing between an unauthenticated visitor and a
 * published asset — 14.3 hands the page to anyone holding the link — so guessing one must
 * be infeasible against an attacker who can enumerate at network speed.
 *
 * 32 bytes = 256 bits of entropy, rendered base64url as 43 characters. That is the same
 * budget a session identifier gets in `services/account/`, and for the same reason: both
 * are bearer credentials whose only defence is their width.
 *
 * The *bytes* are the requirement; the encoding is presentation. `isShareToken` checks the
 * rendered form, and `SHARE_TOKEN_LENGTH` is what base64url of 32 bytes comes to.
 */
export const SHARE_TOKEN_ENTROPY_BYTES = 32;
export const SHARE_TOKEN_LENGTH = 43;

/** Requirement 14.5's feed page. Same ceiling as the library's, for the same reason. */
export const FEED_PAGE_SIZE_MAX = 50;
export const FEED_PAGE_SIZE_DEFAULT = 20;

/**
 * Requirement 14.6's 장르.
 *
 * Genres are engine-reported (Requirement 3.4's `genres`), normalised the way tags are, and
 * capped so an engine answering with a paragraph cannot turn one asset into a hundred feed
 * index rows. Ten is past every genre list the engine's own vocabulary produces
 * (`acestep/genres_vocab.txt` lists single labels) and small enough to stay a facet.
 */
export const ASSET_GENRE_MIN_LENGTH = 1;
export const ASSET_GENRE_MAX_LENGTH = 40;
export const ASSET_GENRE_COUNT_MAX = 10;

/** Requirement 14.5's ordering, and its default. */
export const FEED_SORT_KEYS = ['published_at', 'play_count', 'like_count'] as const;
export type FeedSortKey = (typeof FEED_SORT_KEYS)[number];

/** Newest publication first: a discovery feed is about what has just appeared. */
export const FEED_SORT_KEY_DEFAULT: FeedSortKey = 'published_at';

export function isFeedSortKey(value: unknown): value is FeedSortKey {
  return typeof value === 'string' && (FEED_SORT_KEYS as readonly string[]).includes(value);
}

export function isFeedPageSize(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= FEED_PAGE_SIZE_MAX
  );
}
