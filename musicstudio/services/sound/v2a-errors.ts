/**
 * The V2A_Service's five rejections.
 *
 * All are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no new
 * branch and `details` reaches the client inside the `error` object — the same contract
 * Requirements 3.5/4.6, 7.2/7.4, 21.18 and 22.3/22.19 already use.
 *
 * - `v2aRequestRejected` is Requirement 23.1's 1–4 variant cap. 400, and raised before the
 *   upload is probed, so a request that cannot be satisfied never touches the file.
 * - `v2aUploadRejected` is Requirement 23.4: every violated constraint name with the measured
 *   value and the permitted range. 400, because the request named an unusable file.
 * - `v2aUploadUnreadable` is the case 23.4 does not quite cover — a container that could not
 *   be probed at all, so there are no measurements to report. 400 for the same reason, with
 *   the probe's own detail.
 * - `v2aConsentMissing` is Requirement 23.11: the missing consent item, refused before
 *   anything is charged. 403, matching how Requirement 16's other consent refusals present.
 * - `v2aGenerationFailed` covers 23.17 and the all-variants-failed case: the failure reason
 *   and **the number of segments that did complete**, which 23.17 asks for by name. 422,
 *   because nothing about the request was wrong.
 */

import type { JobFailure } from '../../domain/generation-job/failure';
import { describeViolation, type SongFieldViolation } from '../../domain/song/violation';
import {
  V2A_CONTAINERS,
  V2A_DURATION_MS_MAX,
  V2A_DURATION_MS_MIN,
  V2A_FILE_SIZE_BYTES_MAX,
  V2A_FRAME_RATE_MAX,
  V2A_FRAME_RATE_MIN,
  V2A_SHORT_SIDE_MIN_PX,
  V2A_VARIANT_COUNT_MAX,
  V2A_VARIANT_COUNT_MIN,
} from '../../domain/v2a/bounds';
import {
  V2A_UPLOAD_CONSTRAINT_REQUIREMENT,
  type V2aUploadConstraint,
} from '../../domain/v2a/validation';
import { GenerationError } from '../generation/errors';

import { V2A_QUALITY_CRITERION_REQUIREMENT, type FailedV2aVariant } from './v2a-result';

/** The allowances, echoed on every upload rejection so a client can self-correct. */
export const V2A_UPLOAD_ALLOWANCE = {
  containers: V2A_CONTAINERS,
  frameRateMin: V2A_FRAME_RATE_MIN,
  frameRateMax: V2A_FRAME_RATE_MAX,
  shortSideMinPx: V2A_SHORT_SIDE_MIN_PX,
  durationMsMin: V2A_DURATION_MS_MIN,
  durationMsMax: V2A_DURATION_MS_MAX,
  fileSizeBytesMax: V2A_FILE_SIZE_BYTES_MAX,
} as const;

export interface V2aUploadRejectedDetail {
  readonly uploadId: string;
  readonly violations: readonly SongFieldViolation[];
  readonly constraints: readonly V2aUploadConstraint[];
  /** Requirement 23.4: confirms the file was not kept. */
  readonly uploadDiscarded: boolean;
}

export function v2aUploadRejected(detail: V2aUploadRejectedDetail): GenerationError {
  return new GenerationError(
    400,
    'v2a_upload_rejected',
    detail.violations.map(describeViolation).join('; '),
    {
      uploadId: detail.uploadId,
      violations: detail.violations,
      constraints: detail.constraints,
      requirements: detail.constraints.map(
        (constraint) => V2A_UPLOAD_CONSTRAINT_REQUIREMENT[constraint],
      ),
      allowance: V2A_UPLOAD_ALLOWANCE,
      uploadDiscarded: detail.uploadDiscarded,
    },
  );
}

export function v2aUploadUnreadable(uploadId: string, probeDetail: string): GenerationError {
  return new GenerationError(
    400,
    'v2a_upload_unreadable',
    'The uploaded video could not be read as a container this service supports.',
    { uploadId, detail: probeDetail, allowance: V2A_UPLOAD_ALLOWANCE, uploadDiscarded: true },
  );
}

/**
 * Requirement 23.11 — the uploader has not confirmed they hold rights to the video.
 *
 * The missing item is named rather than described, because 23.11 asks for "누락된 동의 항목".
 * The consent itself is Requirement 16.14's, modelled in
 * `domain/moderation/upload-consent.ts`; this task wires that model rather than restating it.
 */
export function v2aConsentMissing(uploadId: string, missing: readonly string[]): GenerationError {
  return new GenerationError(
    403,
    'v2a_upload_consent_missing',
    'Foley generation needs the uploader’s confirmation that they hold rights to the video.',
    { uploadId, missingConsent: missing, requirements: ['23.11', '16.14'] },
  );
}

/**
 * Requirement 23.1's 1–4 cap, refused before the file is probed.
 *
 * Requirement 23 states the cap but — unlike Requirement 22.18 for sound effects — never spells
 * out the refusal, so the *form* here is borrowed from 22.18: the constraint name, the input
 * value and the permitted range, nothing charged and nothing stored. See
 * `domain/v2a/validation.ts` for why silently clamping would be worse.
 */
export function v2aRequestRejected(violations: readonly SongFieldViolation[]): GenerationError {
  return new GenerationError(
    400,
    'v2a_request_rejected',
    violations.map(describeViolation).join('; '),
    {
      violations,
      requirements: ['23.1'],
      variantCountMin: V2A_VARIANT_COUNT_MIN,
      variantCountMax: V2A_VARIANT_COUNT_MAX,
    },
  );
}

export interface V2aGenerationFailedDetail {
  readonly jobId: string | null;
  readonly failures: readonly FailedV2aVariant[];
  readonly refundedAmount: number;
  /** Requirement 23.17: 생성이 완료된 구간 수. */
  readonly completedSegmentCount: number;
  readonly segmentCount: number;
  readonly qualityThresholdSetVersion: number;
  /** Present when the cause was Requirement 23.17's 900-second budget. */
  readonly timedOut: boolean;
  readonly failure: JobFailure | null;
}

export function v2aGenerationFailed(detail: V2aGenerationFailedDetail): GenerationError {
  return new GenerationError(
    422,
    detail.timedOut ? 'v2a_generation_timed_out' : 'v2a_generation_failed',
    detail.timedOut
      ? `Foley generation did not complete within its budget; ${String(detail.completedSegmentCount)} of ${String(detail.segmentCount)} segments finished.`
      : `All ${String(detail.failures.length)} foley variants failed.`,
    {
      jobId: detail.jobId,
      // Requirement 23.17 asks for this number by name, and 23.7's sequential generation is
      // what makes it meaningful: the count is how far along the clip the job got.
      completedSegmentCount: detail.completedSegmentCount,
      segmentCount: detail.segmentCount,
      // Requirement 23.17: no partial audio becomes an Audio_Asset. Stated in the payload so
      // a client is not left guessing whether a partial result is waiting somewhere.
      partialAudioStored: false,
      failures: detail.failures.map((variant) => ({
        seed: variant.seed,
        jobId: variant.jobId,
        reason: variant.reason,
        unmet: variant.unmet,
        requirements: variant.unmet.map(
          (criterion) => V2A_QUALITY_CRITERION_REQUIREMENT[criterion],
        ),
        completedSegmentCount: variant.completedSegmentCount,
      })),
      refundedAmount: detail.refundedAmount,
      qualityThresholdSetVersion: detail.qualityThresholdSetVersion,
      ...(detail.failure === null ? {} : { failure: detail.failure }),
    },
  );
}
