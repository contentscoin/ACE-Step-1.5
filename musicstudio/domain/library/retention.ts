/**
 * Soft deletion and its expiry (Requirements 11.6, 11.7, 11.8).
 *
 * Three clauses that only make sense together: 11.6 marks, 11.7 hides what is marked, and
 * 11.8 destroys it thirty days later. The middle one is enforced in `applyLibraryQuery`,
 * where every listing passes; the outer two are here, as arithmetic over a mark time so
 * that "has thirty days passed" has one answer and no caller reaches for `Date.now()` on
 * its own.
 */

import { SOFT_DELETE_RETENTION_MS } from './bounds';

export interface SoftDeletionState {
  readonly isDeleted: boolean;
  /** When 11.6's mark was made. `null` whenever `isDeleted` is false. */
  readonly deletedAtMs: number | null;
}

/** When 11.8's permanent deletion becomes due. `null` for an asset that is not marked. */
export function purgeDueAtMs(state: SoftDeletionState): number | null {
  if (!state.isDeleted || state.deletedAtMs === null) return null;
  return state.deletedAtMs + SOFT_DELETE_RETENTION_MS;
}

/**
 * Requirement 11.8: has this asset outlived the retention window?
 *
 * Inclusive at the boundary — an asset marked exactly thirty days ago is due — because
 * 11.8 says 경과하면 and an exclusive test would hold the asset for an extra sweep with
 * nothing to show for it.
 */
export function isPurgeDue(state: SoftDeletionState, nowMs: number): boolean {
  const due = purgeDueAtMs(state);
  return due !== null && nowMs >= due;
}

/** What remains of the window, in milliseconds. `null` when the asset is not marked. */
export function retentionRemainingMs(
  state: SoftDeletionState,
  nowMs: number,
): number | null {
  const due = purgeDueAtMs(state);
  return due === null ? null : Math.max(0, due - nowMs);
}

/**
 * Requirement 11.6's transition.
 *
 * Returns the new state rather than mutating, so a caller that fails to persist has not
 * already changed the asset it was holding — the same shape every command in
 * `domain/timeline/commands.ts` uses.
 */
export function markDeleted(nowMs: number): SoftDeletionState {
  return { isDeleted: true, deletedAtMs: nowMs };
}

/**
 * Restoration, which Requirement 11.11 names among the operations every kind must support.
 *
 * Clearing `deletedAtMs` alongside the flag is what keeps `audio_asset_deleted_at_consistent`
 * in `0003_audio_asset.sql` satisfiable; a restored asset that kept its mark time would
 * also restart the retention clock if it were deleted again.
 */
export function markRestored(): SoftDeletionState {
  return { isDeleted: false, deletedAtMs: null };
}
