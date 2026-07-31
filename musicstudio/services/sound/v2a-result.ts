/**
 * What the V2A_Service returns, and how Requirement 23's metadata is assembled.
 *
 * Split out of `v2a-service.ts` for the reason `sfx-result.ts` is split out of
 * `sfx-service.ts`: this is the part with no control flow. Given a joined audio, its
 * verdicts and its preview, the metadata is determined — so the fields of 23.10, 23.15 and
 * 23.16 can be checked without running a generation, and the service reads as the sequence
 * of decisions it is.
 */

import type { AlignmentVerdict } from '../../domain/v2a/alignment';
import type { DurationVerdict } from '../../domain/v2a/duration';
import type { V2aAssetMetadata } from '../../domain/v2a/metadata';
import type { PreviewSyncVerdict } from '../../domain/v2a/preview';
import type { V2aDefaultableField, V2aParameters } from '../../domain/v2a/request';
import type { VisualEventTimeline } from '../../domain/v2a/visual-event-timeline';
import type { BlockedModeration } from '../moderation/decision';

import type { AudioShape } from './measurement';
import type { PreviewMuxResult } from './v2a-ports';

/**
 * The quality criteria a produced foley variant is judged on.
 *
 * Three names, all three applying to every variant — unlike Requirement 22's loop/one-shot
 * pair, which are mutually exclusive. Machine-readable identifiers because they cross the API
 * boundary in the rejection payload.
 */
export const V2A_QUALITY_CRITERIA = [
  /** Requirement 23.8: ≥90 % of confident visual events have an onset within ±80 ms. */
  'onset_alignment',
  /** Requirement 23.9: output length within ±40 ms of the video. */
  'output_duration',
  /** Requirement 23.12: preview audio/video start offset within ±20 ms. */
  'preview_sync',
] as const;

export type V2aQualityCriterion = (typeof V2A_QUALITY_CRITERIA)[number];

export const V2A_QUALITY_CRITERION_REQUIREMENT: Readonly<Record<V2aQualityCriterion, string>> = {
  onset_alignment: '23.8',
  output_duration: '23.9',
  preview_sync: '23.12',
};

/** Why one variant of a foley request did not survive. */
export const V2A_FAILURE_REASONS = ['engine_failure', 'quality_unmet'] as const;

export type V2aFailureReason = (typeof V2A_FAILURE_REASONS)[number];

export interface FailedV2aVariant {
  readonly seed: number;
  readonly jobId: string | null;
  readonly reason: V2aFailureReason;
  /** Present for `quality_unmet`. */
  readonly unmet: readonly V2aQualityCriterion[];
  /** Present for `engine_failure`. */
  readonly failure: import('../../domain/generation-job/failure').JobFailure | null;
  /** Requirement 23.17 and 23.7 diagnosis: how many segments completed. */
  readonly completedSegmentCount: number;
}

export interface ProducedV2aVariant {
  readonly jobId: string;
  readonly assetId: string;
  /** Requirements 23.10, 23.15, 23.16. */
  readonly metadata: V2aAssetMetadata;
  readonly seed: number;
  /** Requirement 23.8's verdict, including 23.16's unmeasurable case. */
  readonly alignment: AlignmentVerdict;
  /** Requirement 23.9's verdict. */
  readonly duration: DurationVerdict;
  /** Requirement 23.12's sync verdict. */
  readonly previewSync: PreviewSyncVerdict;
  /** Requirement 23.7: the segment count this variant was generated in. */
  readonly segmentCount: number;
}

/** Requirement 23.1's applied values, echoed to the caller as 22.17 does for `sfx`. */
export interface V2aAppliedDefaults {
  readonly variantCount: number;
  readonly defaultedFields: readonly V2aDefaultableField[];
}

export interface ProducedV2aSet {
  readonly kind: 'produced';
  /** Requirement 23.1: 1–4 assets, in variant order. */
  readonly variants: readonly ProducedV2aVariant[];
  readonly failures: readonly FailedV2aVariant[];
  readonly refundedAmount: number;
  readonly applied: V2aAppliedDefaults;
  /** The base seed — the caller's, or the one drawn per 23.14. */
  readonly baseSeed: number;
  readonly engineId: string;
  /** Requirement 23.7: segments the clip was split into. */
  readonly segmentCount: number;
  /** Requirement 23.3, echoed so a caller can check 23.9 itself. */
  readonly inputVideoDurationMs: number;
  /**
   * Requirement 23.13: the interval in which the uploaded video must be deleted.
   *
   * Returned rather than acted on. The upload *is* discarded by the service once the preview
   * exists (the `notBefore` half), and the `notAfter` half is a policy instant a sweep or an
   * object-store lifecycle rule can be checked against — see `domain/v2a/retention.ts` for
   * why retention is expressed as data here.
   */
  readonly sourceVideoDeletionNotAfterMs: number;
}

export type V2aOutcome =
  | ProducedV2aSet
  /**
   * Requirements 16.2, 16.11, 16.14, 23.11 — refused before anything was charged.
   *
   * Whole-request rather than per-variant: the video and the prompt are shared, so one
   * verdict settles every variant, and 23.11's missing-consent refusal is about the upload.
   */
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };

export function v2aAppliedDefaults(parameters: V2aParameters): V2aAppliedDefaults {
  return {
    variantCount: parameters.variantCount,
    defaultedFields: parameters.appliedDefaults,
  };
}

export interface V2aMetadataInput {
  readonly parameters: V2aParameters;
  readonly seed: number;
  readonly timeline: VisualEventTimeline;
  readonly alignment: AlignmentVerdict;
  readonly shape: AudioShape;
  readonly inputVideoDurationMs: number;
  readonly segmentCount: number;
  readonly preview: PreviewMuxResult;
  readonly previewSync: PreviewSyncVerdict;
  readonly previewRetainedUntilMs: number;
  /** Requirement 34.6: the set every verdict above was taken against. */
  readonly qualityThresholdSetVersion: number;
}

/**
 * Requirement 23.10's lineage fields, 23.15's timeline, 23.16's status and 34.6's version.
 *
 * The alignment rate is `null` exactly when 23.16 applies — see `V2aAssetMetadata`. Reading it
 * off the verdict rather than recomputing it is what keeps the stored number and the verdict
 * that admitted the asset the same number.
 */
export function v2aMetadata(input: V2aMetadataInput): V2aAssetMetadata {
  return {
    sourceVideoUploadId: input.parameters.uploadId,
    prompt: input.parameters.prompt,
    timeline: input.timeline,
    detectionStatus: input.timeline.status,
    onsetAlignmentRate: input.alignment.kind === 'measured' ? input.alignment.rate : null,
    segmentCount: input.segmentCount,
    seed: input.seed,
    durationMs: Math.round(input.shape.durationMs),
    inputVideoDurationMs: input.inputVideoDurationMs,
    sampleRate: input.shape.sampleRate,
    channels: input.shape.channels,
    previewFileId: input.preview.previewFileId,
    previewRetainedUntilMs: input.previewRetainedUntilMs,
    previewSyncOffsetMs: input.previewSync.offsetMs,
    qualityThresholdSetVersion: input.qualityThresholdSetVersion,
  };
}
