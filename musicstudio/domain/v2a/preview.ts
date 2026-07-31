/**
 * The preview video's audio/video synchronisation (Requirement 23.12).
 *
 * "산출 오디오 시작 시각과 영상 시작 시각의 차이가 ±20밀리초 이내가 되도록 제공하고" — the
 * preview is only useful if the sound lands where the picture does, and 20 ms is roughly the
 * point at which a viewer stops perceiving an impact and its sound as one event.
 *
 * A predicate over a *measurement*, in the same shape as `domain/v2a/duration.ts` and for the
 * same reason: muxing needs a container writer, which task 3.1's DSP worker supplies through
 * `V2aPreviewMuxPort`; deciding whether what came back is in sync is arithmetic, and belongs
 * where it can be tested without one.
 *
 * The tolerance is the Quality_Threshold_Set member `v2a_preview_sync_tolerance_ms`
 * (Requirement 34.1), read through `domain/quality/v2a-thresholds.ts`.
 *
 * The retention half of 23.12 is `domain/v2a/retention.ts`; only the sync half is here.
 */

import type { V2aPreviewSyncThresholds } from '../quality/v2a-thresholds';

export interface PreviewSyncMeasurement {
  /** Where the foley audio starts within the preview container, milliseconds. */
  readonly audioStartMs: number;
  /** Where the video track starts within the same container, milliseconds. */
  readonly videoStartMs: number;
}

export interface PreviewSyncVerdict {
  readonly satisfied: boolean;
  /** `audioStart − videoStart`; positive means the sound starts late. */
  readonly offsetMs: number;
  readonly toleranceMs: number;
  /** Requirement 34.6. */
  readonly thresholdSetVersion: number;
}

/**
 * Requirement 23.12's sync check.
 *
 * An unmeasurable offset fails rather than throwing, for the reason
 * `evaluateOutputDuration` gives: the criterion is a claim about evidence, and absent
 * evidence is not compliance.
 */
export function evaluatePreviewSync(
  measurement: PreviewSyncMeasurement,
  thresholds: V2aPreviewSyncThresholds,
): PreviewSyncVerdict {
  const finite =
    Number.isFinite(measurement.audioStartMs) && Number.isFinite(measurement.videoStartMs);
  const offsetMs = finite
    ? measurement.audioStartMs - measurement.videoStartMs
    : Number.POSITIVE_INFINITY;

  return {
    satisfied: finite && Math.abs(offsetMs) <= thresholds.previewSyncToleranceMs,
    offsetMs,
    toleranceMs: thresholds.previewSyncToleranceMs,
    thresholdSetVersion: thresholds.version,
  };
}
