/**
 * The page cursor as one opaque string (Requirement 11.2).
 *
 * `LibraryCursor` is three values — the sort key it was taken under, the last row's sort value,
 * and that row's identifier — because a keyset seek needs all three. A client has no use for
 * any of them: it received a cursor and it hands the same cursor back. So the transport carries
 * one string, and this is the printer and parser for it.
 *
 * ### Opaque on purpose, but not secret
 *
 * base64url of the JSON triple. Anyone who decodes it learns a timestamp and an identifier they
 * were already shown, so nothing is hidden; what the encoding buys is that the *shape* is not
 * part of the API. A cursor spelled as three query parameters would make the keyset design a
 * published contract, and changing it later would break every stored link.
 *
 * ### Parsing never throws
 *
 * A cursor arrives from a URL, so it can be truncated, stale, hand-edited or from another
 * deployment. `decodeLibraryCursor` answers `null` for anything it cannot read, and `null` is
 * what `LibraryQueryInput` already means by "start at the beginning". A malformed cursor
 * therefore serves the first page rather than a 400 — the user asked for a listing, and there
 * is a correct listing to give them. A cursor that parses but names a *different* sort key is
 * a different failure and is not this module's to forgive: `libraryQueryViolations` rejects it
 * with `cursor_sort_key_mismatch`, because that one means the client changed the order and kept
 * the cursor, and silently restarting would look like the sort had been ignored.
 */

import { isLibrarySortKey } from './bounds';
import type { LibraryCursor } from './query';

export function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(
    JSON.stringify({ k: cursor.sortKey, v: cursor.value, i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeLibraryCursor(encoded: unknown): LibraryCursor | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { k?: unknown; v?: unknown; i?: unknown };

  if (!isLibrarySortKey(candidate.k)) return null;
  if (typeof candidate.i !== 'string' || candidate.i.length === 0) return null;
  if (typeof candidate.v !== 'string' && typeof candidate.v !== 'number') return null;

  return { sortKey: candidate.k, value: candidate.v, id: candidate.i };
}
