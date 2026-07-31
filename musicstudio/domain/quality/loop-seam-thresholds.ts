/**
 * The four loop-seam numbers, projected out of the Quality_Threshold_Set.
 *
 * Requirement 21.6 names four co-equal criteria — RMS difference, sample step, edge
 * energy, bar alignment — and Requirement 34.1/34.3 make each of them a member of
 * the set rather than a literal. This projection is how the loop predicates read
 * them: one call, one version identifier, so a verdict and the version recorded
 * beside it (34.6) cannot come from different sets.
 *
 * It exists as a named type rather than as four loose arguments so that adding a
 * fifth criterion is a change to one shape, and so a test can state a threshold
 * variation without constructing a whole set.
 */

import { thresholdValue, type QualityThresholdSet } from './threshold-set';

export interface LoopSeamThresholds {
  /** Requirement 34.6: recorded on every asset admitted against these values. */
  readonly version: number;
  /** Requirement 21.7, dB. */
  readonly seamRmsDifferenceMaxDb: number;
  /** Requirement 21.8, fraction of the channel's peak absolute amplitude. */
  readonly seamSampleStepRatioMax: number;
  /** Requirement 21.16, dB relative to the asset's overall RMS. Negative. */
  readonly edgeEnergyFloorDb: number;
  /** Requirement 21.17, milliseconds. */
  readonly barAlignmentToleranceMs: number;
}

export function loopSeamThresholds(set: QualityThresholdSet): LoopSeamThresholds {
  return {
    version: set.version,
    seamRmsDifferenceMaxDb: thresholdValue(set, 'loop_seam_rms_difference_max'),
    seamSampleStepRatioMax: thresholdValue(set, 'loop_seam_sample_step_ratio_max'),
    edgeEnergyFloorDb: thresholdValue(set, 'loop_edge_energy_floor'),
    barAlignmentToleranceMs: thresholdValue(set, 'loop_bar_alignment_tolerance_ms'),
  };
}
