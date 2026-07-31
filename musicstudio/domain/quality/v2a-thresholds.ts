/**
 * The six V2A numbers, projected out of the Quality_Threshold_Set.
 *
 * Requirement 23 quotes them as literals — a 6.0 dB rise, a 0.50 confidence floor, a
 * ±80 ms window, a 90 % rate, a ±20 ms preview offset, a ±40 ms duration error — and
 * Requirement 34.1/34.3 make each of them a *member of the set* rather than a constant.
 * So nothing under `domain/v2a/` or `services/sound/v2a-*` inlines any of them; they all
 * arrive through this projection.
 *
 * Same shape and same reason as `loop-seam-thresholds.ts` and
 * `one-shot-tail-thresholds.ts`: one call yields the values and the version they came
 * from together, so a verdict and the version recorded beside it (Requirement 34.6)
 * cannot come from two different sets. A generation that spans several seconds must not
 * judge its first segment against version 3 and its last against version 4.
 *
 * Three projections rather than one, because the three verdicts are taken at different
 * points and by different code — the onset rule inside the alignment check, the sync
 * rule after the preview is muxed, the duration rule on the joined audio — and a
 * function that needed all six to answer any one of them would couple them for no
 * reason. `v2aThresholds` composes all three for a caller that wants the whole picture.
 */

import { thresholdValue, type QualityThresholdSet } from './threshold-set';

export interface V2aOnsetAlignmentThresholds {
  /** Requirement 34.6: recorded on every asset admitted against these values. */
  readonly version: number;
  /** Requirement 23.8: the short-term RMS rise that marks an onset, in dB. */
  readonly onsetRiseDb: number;
  /** Requirements 23.8, 23.15, 23.16: events below this confidence are ignored. */
  readonly visualEventConfidenceMin: number;
  /** Requirement 23.8: half-width of the window an onset must fall in, in ms. */
  readonly alignmentToleranceMs: number;
  /** Requirement 23.8: fraction of confident events that must be aligned, 0..1. */
  readonly alignmentRateMin: number;
}

export function v2aOnsetAlignmentThresholds(
  set: QualityThresholdSet,
): V2aOnsetAlignmentThresholds {
  return {
    version: set.version,
    onsetRiseDb: thresholdValue(set, 'v2a_onset_rise_db'),
    visualEventConfidenceMin: thresholdValue(set, 'v2a_visual_event_confidence_min'),
    alignmentToleranceMs: thresholdValue(set, 'v2a_onset_alignment_tolerance_ms'),
    alignmentRateMin: thresholdValue(set, 'v2a_onset_alignment_rate_min'),
  };
}

export interface V2aPreviewSyncThresholds {
  readonly version: number;
  /** Requirement 23.12: |audio start − video start| ceiling, in ms. */
  readonly previewSyncToleranceMs: number;
}

export function v2aPreviewSyncThresholds(set: QualityThresholdSet): V2aPreviewSyncThresholds {
  return {
    version: set.version,
    previewSyncToleranceMs: thresholdValue(set, 'v2a_preview_sync_tolerance_ms'),
  };
}

export interface V2aDurationThresholds {
  readonly version: number;
  /** Requirement 23.9: |output duration − input duration| ceiling, in ms. */
  readonly outputDurationToleranceMs: number;
}

export function v2aDurationThresholds(set: QualityThresholdSet): V2aDurationThresholds {
  return {
    version: set.version,
    outputDurationToleranceMs: thresholdValue(set, 'v2a_output_duration_tolerance_ms'),
  };
}

/** All three projections at one version, for a caller that judges every rule. */
export interface V2aThresholds
  extends V2aOnsetAlignmentThresholds,
    V2aPreviewSyncThresholds,
    V2aDurationThresholds {}

export function v2aThresholds(set: QualityThresholdSet): V2aThresholds {
  return {
    ...v2aOnsetAlignmentThresholds(set),
    ...v2aPreviewSyncThresholds(set),
    ...v2aDurationThresholds(set),
  };
}
