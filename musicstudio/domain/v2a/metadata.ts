/**
 * What Requirement 23 records on a produced foley `sfx` Audio_Asset.
 *
 * 23.10 requires the source video identifier and the prompt used as *lineage* information;
 * 23.15 requires the Visual_Event_Timeline as asset metadata; 23.16 requires the detection
 * status; 23.12 requires a preview file that stays readable for 168 hours; 23.14's
 * reproducibility needs the seed to have been recorded, and Requirement 34.6 requires the
 * version of the Quality_Threshold_Set the asset was admitted against.
 *
 * Assembled by one pure function, exactly as `domain/sfx/metadata.ts` and
 * `domain/bgm/metadata.ts` are, so every one of those fields can be checked without running
 * a generation.
 *
 * ### 23.10's lineage is *also* an edge, not only a field
 *
 * The source video identifier appears here as metadata **and** the service records a lineage
 * edge through the existing publication path. They are not redundant: the edge is what
 * Requirement 19.7's DAG and Requirement 33.21's commercial-use propagation traverse, and the
 * field is what a user sees on the asset. An upload identifier is not itself an `Audio_Asset`,
 * so it cannot be an edge on its own — which is why the field carries it and why
 * `V2aAssetMetadata` is where 23.10's "사용된 프롬프트" is preserved verbatim.
 */

import type { VisualEventTimeline, V2aDetectionStatus } from './visual-event-timeline';

export interface V2aAssetMetadata {
  /** Requirement 23.10: the uploaded video this foley was generated from. */
  readonly sourceVideoUploadId: string;
  /** Requirement 23.10: the prompt used, or `null` when the caller supplied none. */
  readonly prompt: string | null;
  /** Requirement 23.15, ascending by time, confidences clamped to `[0, 1]`. */
  readonly timeline: VisualEventTimeline;
  /** Requirement 23.16. */
  readonly detectionStatus: V2aDetectionStatus;
  /**
   * Requirement 23.8's measured rate, or `null` under 23.16.
   *
   * `null` rather than 0 or 1 for a clip with no confident event: no rate was measured, and
   * recording a number would misreport an unmeasured quantity as a measured one. See
   * `domain/v2a/alignment.ts`.
   */
  readonly onsetAlignmentRate: number | null;
  /** Requirement 23.7: how many segments the clip was generated in. */
  readonly segmentCount: number;
  /** Requirement 23.14: the seed this variant actually used. */
  readonly seed: number;
  /** Requirement 23.9's subject, and its reference. */
  readonly durationMs: number;
  readonly inputVideoDurationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirement 23.12: the muxed preview, and how long it is guaranteed readable. */
  readonly previewFileId: string;
  readonly previewRetainedUntilMs: number;
  /** Requirement 23.12: the measured audio/video start offset of that preview. */
  readonly previewSyncOffsetMs: number;
  /** Requirement 34.6. */
  readonly qualityThresholdSetVersion: number;
}

/** Requirement 23.10's lineage statement, in the shape the publication path records. */
export interface V2aLineage {
  readonly sourceVideoUploadId: string;
  readonly prompt: string | null;
}

export function v2aLineageOf(metadata: V2aAssetMetadata): V2aLineage {
  return {
    sourceVideoUploadId: metadata.sourceVideoUploadId,
    prompt: metadata.prompt,
  };
}
