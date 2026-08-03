/**
 * A library listing: what to return, in what order, and where the next page starts.
 *
 * Requirements 11.1, 11.2, 11.3, 11.4, 11.7, 11.12. Pure over a summary record, so the
 * ordering and the matching can be tested without a database and so an in-memory store and
 * a SQL one cannot disagree about what "sorted by title" or "contains the search term"
 * means — the seam `services/library/ports.ts` describes.
 *
 * ### Why the cursor carries the sort key
 *
 * Requirement 11.2 asks for "다음 페이지 커서" and 11.4 lets the caller choose the order.
 * A cursor that recorded only a position would silently mean something different if the
 * caller changed the order between pages, and the second page would overlap or skip. The
 * cursor therefore names the order it was issued for and a listing refuses a cursor that
 * does not match the order being asked for.
 */

import { isAssetKind, type AssetKind } from '../asset-kind';
import {
  isLibraryPageSize,
  isLibrarySortKey,
  LIBRARY_PAGE_SIZE_DEFAULT,
  LIBRARY_SORT_KEY_DEFAULT,
  type LibrarySortKey,
} from './bounds';
import { normaliseTag } from './tags';

/** What a listing needs to sort, filter and match. Not the whole `Audio_Asset`. */
export interface LibraryAssetSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly assetKind: AssetKind;
  readonly caption: string;
  readonly lyrics: string;
  readonly tags: readonly string[];
  readonly playCount: number;
  readonly createdAtMs: number;
  readonly isDeleted: boolean;
}

export interface LibraryQuery {
  readonly ownerId: string;
  readonly pageSize: number;
  readonly sortKey: LibrarySortKey;
  /** `null` means every kind — Requirement 11.11's "어느 값이든 동일한" listing. */
  readonly assetKind: AssetKind | null;
  /** `null` means no search. Normalised the way a tag is, so matching is case-blind. */
  readonly search: string | null;
  readonly cursor: LibraryCursor | null;
}

export interface LibraryCursor {
  readonly sortKey: LibrarySortKey;
  /** The last row's sort value: a timestamp, a lower-cased title, or a play count. */
  readonly value: string | number;
  /** The last row's identifier, which breaks ties so the order is total. */
  readonly id: string;
}

export type LibraryQueryViolationCode =
  | 'page_size_invalid'
  | 'sort_key_unknown'
  | 'asset_kind_unknown'
  | 'cursor_sort_key_mismatch';

export interface LibraryQueryViolation {
  readonly field: string;
  readonly violation: LibraryQueryViolationCode;
  readonly expected?: string;
  readonly actual?: string;
}

export interface LibraryQueryInput {
  readonly ownerId: string;
  readonly pageSize?: number;
  readonly sortKey?: string;
  readonly assetKind?: string | null;
  readonly search?: string | null;
  readonly cursor?: LibraryCursor | null;
}

export function libraryQueryViolations(input: LibraryQueryInput): LibraryQueryViolation[] {
  const violations: LibraryQueryViolation[] = [];

  if (input.pageSize !== undefined && !isLibraryPageSize(input.pageSize)) {
    violations.push({
      field: 'pageSize',
      violation: 'page_size_invalid',
      expected: `1..${String(LIBRARY_PAGE_SIZE_DEFAULT)}`,
      actual: String(input.pageSize),
    });
  }
  if (input.sortKey !== undefined && !isLibrarySortKey(input.sortKey)) {
    violations.push({
      field: 'sortKey',
      violation: 'sort_key_unknown',
      actual: String(input.sortKey),
    });
  }
  if (
    input.assetKind !== undefined &&
    input.assetKind !== null &&
    !isAssetKind(input.assetKind)
  ) {
    violations.push({
      field: 'assetKind',
      violation: 'asset_kind_unknown',
      actual: String(input.assetKind),
    });
  }

  // See the header: a cursor is only meaningful for the order it was issued for.
  const sortKey = isLibrarySortKey(input.sortKey) ? input.sortKey : LIBRARY_SORT_KEY_DEFAULT;
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

/** Fill the defaults Requirements 11.1 and 11.2 state. Call only on a valid input. */
export function toLibraryQuery(input: LibraryQueryInput): LibraryQuery {
  const search = input.search == null ? null : normaliseTag(input.search);
  return {
    ownerId: input.ownerId,
    pageSize: input.pageSize ?? LIBRARY_PAGE_SIZE_DEFAULT,
    sortKey: isLibrarySortKey(input.sortKey) ? input.sortKey : LIBRARY_SORT_KEY_DEFAULT,
    assetKind: isAssetKind(input.assetKind) ? input.assetKind : null,
    search: search === '' ? null : search,
    cursor: input.cursor ?? null,
  };
}

/**
 * Requirement 11.3: the term appears in the title, the caption, the lyrics or a tag.
 *
 * Substring rather than word matching, because 11.3 says 포함 and a user searching "lofi"
 * should find "lofi-beats". Case-blind on both sides: the stored tag is already normalised,
 * and the other three fields are folded here.
 */
export function matchesSearch(asset: LibraryAssetSummary, term: string): boolean {
  const needle = normaliseTag(term);
  if (needle === '') return true;
  return (
    asset.name.toLowerCase().includes(needle) ||
    asset.caption.toLowerCase().includes(needle) ||
    asset.lyrics.toLowerCase().includes(needle) ||
    asset.tags.some((tag) => tag.includes(needle))
  );
}

/** The value the cursor records for a row, under a given order. */
export function sortValue(asset: LibraryAssetSummary, sortKey: LibrarySortKey): string | number {
  switch (sortKey) {
    case 'title':
      return asset.name.toLowerCase();
    case 'play_count':
      return asset.playCount;
    case 'created_at':
      return asset.createdAtMs;
  }
}

/**
 * Requirement 11.4's order, with the identifier as the tie-break.
 *
 * `created_at` and `play_count` descend — newest and most-played first, which is what
 * 11.1 states for the default and the only reading of a play-count ranking that is useful.
 * `title` ascends, because an alphabetical list that started at Z would surprise. The
 * identifier always ascends, so two rows with the same sort value have one fixed order and
 * a cursor cannot skip or repeat one of them.
 */
export function compareAssets(
  left: LibraryAssetSummary,
  right: LibraryAssetSummary,
  sortKey: LibrarySortKey,
): number {
  const leftValue = sortValue(left, sortKey);
  const rightValue = sortValue(right, sortKey);

  if (leftValue !== rightValue) {
    const ascending = sortKey === 'title';
    const order = leftValue < rightValue ? -1 : 1;
    return ascending ? order : -order;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface LibraryPage {
  readonly assets: readonly LibraryAssetSummary[];
  /** `null` when this is the last page — Requirement 11.2's cursor, spent. */
  readonly nextCursor: LibraryCursor | null;
}

/**
 * Apply a query to a set of assets: filter, sort, seek past the cursor, take a page.
 *
 * Written as one function over the whole set because that is what makes it testable, and
 * because a SQL store implementing the same query has one specification to match rather
 * than four fragments. Requirement 11.7's deletion filter is applied here and not left to
 * the caller, so no listing path can forget it.
 */
export function applyLibraryQuery(
  assets: readonly LibraryAssetSummary[],
  query: LibraryQuery,
): LibraryPage {
  const matching = assets
    .filter((asset) => asset.ownerId === query.ownerId) // Requirement 11.1
    .filter((asset) => !asset.isDeleted) // Requirement 11.7
    .filter((asset) => query.assetKind === null || asset.assetKind === query.assetKind) // 11.12
    .filter((asset) => query.search === null || matchesSearch(asset, query.search)) // 11.3
    .sort((left, right) => compareAssets(left, right, query.sortKey)); // 11.4

  const start = query.cursor === null ? 0 : seekPastCursor(matching, query.cursor, query.sortKey);
  const page = matching.slice(start, start + query.pageSize);
  const last = page.at(-1);
  const exhausted = last === undefined || start + page.length >= matching.length;

  return {
    assets: page,
    nextCursor: exhausted
      ? null
      : { sortKey: query.sortKey, value: sortValue(last, query.sortKey), id: last.id },
  };
}

/**
 * Where the next page begins.
 *
 * By identifier rather than by index: a row inserted or deleted between two requests
 * shifts every index, and a cursor that meant "row 50" would then skip or repeat. Finding
 * the cursor's own row and starting after it is stable under both.
 */
function seekPastCursor(
  sorted: readonly LibraryAssetSummary[],
  cursor: LibraryCursor,
  sortKey: LibrarySortKey,
): number {
  const index = sorted.findIndex((asset) => asset.id === cursor.id);
  if (index >= 0) return index + 1;

  // The cursor's row is gone — renamed out of the filter, deleted, or its sort value moved.
  // Fall back to the first row that sorts after the recorded value, which is the closest
  // thing to "where it would have been" and never revisits a page already served.
  const position = sorted.findIndex((asset) => {
    const value = sortValue(asset, sortKey);
    if (value === cursor.value) return asset.id > cursor.id;
    return sortKey === 'title' ? value > cursor.value : value < cursor.value;
  });
  return position < 0 ? sorted.length : position;
}
