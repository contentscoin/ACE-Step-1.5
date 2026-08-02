/**
 * The five Edit_Task kinds (Requirement 7; design §3.6).
 *
 * Requirement 7's title names five edits — cover, repaint, extend, stem extract,
 * layer add — and criteria 7.1/7.3/7.6/7.7/7.8 give each one an engine `task_type`.
 * The names below are the product layer's vocabulary for those five; the mapping to
 * ACE-Step's `task_type` string stays in `adapters/ace/task-type.ts`, because that
 * is where engine spelling is allowed to be known (design §1.4.4).
 *
 * Two mappings live here because both are properties of the *edit*, not of any
 * engine:
 *
 * - `derivationTypeForEditKind` — Requirement 7.12's "edit kind" as stored on a
 *   lineage edge. The five names coincide with five members of the
 *   `derivation_type` enum task 1.1 defined (design §4.2, `0001_enums.sql`), so the
 *   mapping is an identity that is *asserted* rather than assumed: the return type
 *   is `DerivationType`, so a rename on either side fails the type check.
 * - `assetKindForEditKind` — design §3.6 assigns `task_type=extract` to the `stem`
 *   Asset_Kind and every other song edit to `song`. Requirement 19.7 then demands a
 *   lineage parent for every `stem`, which is why extract's edit path must record
 *   lineage rather than treat it as optional bookkeeping.
 */

import type { AssetKind } from '../asset-kind';
import type { DerivationType } from '../derivation-type';

export const EDIT_KINDS = ['cover', 'repaint', 'extract', 'lego', 'complete'] as const;

export type EditKind = (typeof EDIT_KINDS)[number];

export function isEditKind(value: unknown): value is EditKind {
  return typeof value === 'string' && (EDIT_KINDS as readonly string[]).includes(value);
}

/** Requirement 7.12: the edit kind recorded on the lineage edge. */
export function derivationTypeForEditKind(kind: EditKind): DerivationType {
  return kind;
}

/** Design §3.6: extract yields stems; the other four yield songs. */
export function assetKindForEditKind(kind: EditKind): AssetKind {
  return kind === 'extract' ? 'stem' : 'song';
}

/**
 * Requirements 7.6 and 7.7 both name a track: extract selects the track to pull
 * out, lego names the track to add. The other three kinds have no track.
 */
export const TRACK_NAMED_EDIT_KINDS: readonly EditKind[] = ['extract', 'lego'];

export function requiresTrackName(kind: EditKind): boolean {
  return TRACK_NAMED_EDIT_KINDS.includes(kind);
}
