/**
 * The read seam onto the Quality_Threshold_Set.
 *
 * Every service that judges audio quality needs the set in force *at the moment it
 * judges*, because Requirement 34.4 lets an operator change it between two
 * generations and Requirement 34.6 makes the version part of the asset's provenance.
 * Reading through a source rather than importing `INITIAL_QUALITY_THRESHOLD_SET`
 * directly is what makes that possible without every consumer knowing where the set
 * is stored.
 *
 * Synchronous on purpose: this is configuration held in memory and refreshed by task
 * 8.2's writer, not a per-request database read. An implementation that needs to load
 * it can do so on the write side, where 34.4 already requires a transaction.
 *
 * **Integration point (task 8.2).** The operator CRUD supplies the real source: it
 * applies `changeThreshold`, writes the 34.4 audit entry, and publishes the new set
 * so that `current()` returns it from the next judgement onwards.
 */

import { INITIAL_QUALITY_THRESHOLD_SET, type QualityThresholdSet } from './threshold-set';

export interface QualityThresholdSource {
  /** The set in force now (Requirement 34.2's versioned snapshot). */
  current(): QualityThresholdSet;
}

/** A source pinned to one set. The default until task 8.2 supplies a mutable one. */
export function fixedThresholdSource(
  set: QualityThresholdSet = INITIAL_QUALITY_THRESHOLD_SET,
): QualityThresholdSource {
  return { current: () => set };
}
