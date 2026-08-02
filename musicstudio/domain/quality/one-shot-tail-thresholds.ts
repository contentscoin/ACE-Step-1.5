/**
 * The one-shot tail number, projected out of the Quality_Threshold_Set.
 *
 * Requirement 22.15 quotes 5 %, and Requirement 34.1 already lists it as a member of the
 * set (`one_shot_tail_amplitude_ratio_max`) rather than a constant — so the value the
 * requirement quotes is an *initial* value and nothing may inline it.
 *
 * Same shape and same reason as `loop-seam-thresholds.ts`: one call yields the value and
 * the version it came from together, so a verdict and the version recorded beside it
 * (Requirement 34.6) cannot come from two different sets.
 */

import { thresholdValue, type QualityThresholdSet } from './threshold-set';

export interface OneShotTailThresholds {
  /** Requirement 34.6: recorded on every asset admitted against this value. */
  readonly version: number;
  /** Requirement 22.15, as a fraction of the asset's peak absolute amplitude. */
  readonly tailAmplitudeRatioMax: number;
}

export function oneShotTailThresholds(set: QualityThresholdSet): OneShotTailThresholds {
  return {
    version: set.version,
    tailAmplitudeRatioMax: thresholdValue(set, 'one_shot_tail_amplitude_ratio_max'),
  };
}
