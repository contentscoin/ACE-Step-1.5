/**
 * The library's stated numbers (Requirements 11.2, 11.3, 11.8, 11.10, design §4.1).
 *
 * One module so `db/migrations/0016_library.sql` has a single place to mirror, the way
 * `domain/sound-pack/bounds.ts` is mirrored by `0014_sound_pack.sql`.
 * `test/unit/library/schema-parity.test.ts` fails if the two drift.
 */

/** Requirement 11.2: "페이지당 최대 50건". */
export const LIBRARY_PAGE_SIZE_MAX = 50;
export const LIBRARY_PAGE_SIZE_DEFAULT = 50;

/** Requirement 11.3's 캡션, bounded as Requirement 3.1 bounds the caption it comes from. */
export const ASSET_CAPTION_MAX_LENGTH = 2000;

/**
 * Requirement 11.3's 태그.
 *
 * The two bounds are a product decision — Requirement 11 states neither — recorded here
 * rather than spread across the validator and the DDL. Twenty is generous for the labels a
 * library needs and small enough that a tag list stays a tag list; thirty characters is
 * past every reasonable single tag and short of a sentence.
 */
export const ASSET_TAG_MIN_LENGTH = 1;
export const ASSET_TAG_MAX_LENGTH = 30;
export const ASSET_TAG_COUNT_MAX = 20;

/** Requirement 11.10. Matches `audio_asset`'s own name bound, for the same reason. */
export const PLAYLIST_NAME_MIN_LENGTH = 1;
export const PLAYLIST_NAME_MAX_LENGTH = 200;

/** Requirement 11.8: "삭제 표시 상태의 Audio_Asset이 30일을 경과하면". */
export const SOFT_DELETE_RETENTION_DAYS = 30;
export const SOFT_DELETE_RETENTION_MS = SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

/** Requirement 11.4's three orders, and 11.1's default. */
export const LIBRARY_SORT_KEYS = ['created_at', 'title', 'play_count'] as const;
export type LibrarySortKey = (typeof LIBRARY_SORT_KEYS)[number];

/** Requirement 11.1: "생성 시각 내림차순". */
export const LIBRARY_SORT_KEY_DEFAULT: LibrarySortKey = 'created_at';

export function isLibrarySortKey(value: unknown): value is LibrarySortKey {
  return typeof value === 'string' && (LIBRARY_SORT_KEYS as readonly string[]).includes(value);
}

export function isLibraryPageSize(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= LIBRARY_PAGE_SIZE_MAX
  );
}
