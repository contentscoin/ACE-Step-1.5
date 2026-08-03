/**
 * Requirement 14.6's 장르: where the values come from, and how they are normalised.
 *
 * Genres are not user-authored the way tags are. Requirement 3.4 has the engine report a
 * free-text `genres` field alongside the five other values it settled on, and 14.6 filters
 * the feed by that. Free text is not a facet, so it is split and normalised on the way in —
 * the same lower-and-trim rule tags get, so `Lo-Fi`, `lo-fi ` and `LO-FI` are one genre and
 * a filter does not have to case-fold at read time.
 *
 * **Splitting is the only guessing this module does**, and it is confined to the separators
 * the engine actually emits: commas, slashes and semicolons. A genre containing a space
 * (`hip hop`) survives, because splitting on whitespace would turn one genre into two and
 * make the facet list nonsense. When in doubt the string stays whole: a genre nobody filters
 * by is a smaller failure than a genre that never matches because it was cut in half.
 */

import {
  ASSET_GENRE_COUNT_MAX,
  ASSET_GENRE_MAX_LENGTH,
  ASSET_GENRE_MIN_LENGTH,
} from './bounds';

/** Separators the engine's `genres` field uses between labels. Not whitespace — see above. */
const GENRE_SEPARATORS = /[,;/]+/;

export function normaliseGenre(genre: string): string {
  return genre.trim().toLowerCase();
}

/**
 * Split the engine's free-text genre list into stored genres.
 *
 * Over-long labels are **dropped, not truncated**: a truncated genre is a label nobody will
 * ever filter by and one nobody wrote, whereas a dropped one leaves the asset filterable by
 * whatever else the engine said. The ceiling likewise truncates the *list*, keeping the
 * first labels, which is the order the engine ranks them in.
 */
export function parseGenres(reported: string | null | undefined): string[] {
  if (reported == null) return [];

  const seen = new Set<string>();
  const genres: string[] = [];

  for (const raw of reported.split(GENRE_SEPARATORS)) {
    const genre = normaliseGenre(raw);
    if (genre.length < ASSET_GENRE_MIN_LENGTH) continue;
    if (genre.length > ASSET_GENRE_MAX_LENGTH) continue;
    if (seen.has(genre)) continue;
    seen.add(genre);
    genres.push(genre);
    if (genres.length === ASSET_GENRE_COUNT_MAX) break;
  }

  return genres;
}

export function isStorableGenre(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === normaliseGenre(value) &&
    value.length >= ASSET_GENRE_MIN_LENGTH &&
    value.length <= ASSET_GENRE_MAX_LENGTH
  );
}
