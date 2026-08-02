/**
 * Voice_Profile creation and conversion rejections (Requirements 26.1–26.7, 26.24, 26.25).
 *
 * `GenerationError`s rather than `VoiceError`s, deliberately. `errors.ts` is task 6.2's consent
 * vocabulary — the 403s and 404s of the share list and the withdrawal states — and these are
 * *request* refusals of the same kind Requirements 22.3, 23.4 and 25.22 produce. Putting them in
 * the same class as those means `api/gateway/error-handler.ts` renders them through the one
 * existing contract and a client parses one shape.
 *
 * | criterion | status | code |
 * |---|---|---|
 * | 26.1, 26.7 name or sample count | 400 | `voice_profile_request_invalid` |
 * | 26.2–26.5 a reference sample | 400 | `voice_reference_sample_rejected` |
 * | an unreadable upload | 400 | `voice_reference_sample_unreadable` |
 * | 26.25 length out of window | 422 | `voice_conversion_length_unmet` |
 * | 26.24 engine produced nothing | 422 | `voice_conversion_failed` |
 * | the source asset is missing | 404 | `voice_conversion_source_not_found` |
 *
 * 26.13's consent refusal is **not** here: it is task 6.2's `consentIncomplete`, and duplicating
 * it would create a second answer to "which consent items were not met".
 */

import { describeViolation, type SongFieldViolation } from '../../domain/song/violation';
import type { ConversionLengthVerdict } from '../../domain/voice/conversion';
import {
  REFERENCE_SAMPLE_COUNT_MAX,
  REFERENCE_SAMPLE_COUNT_MIN,
  VOICE_PROFILE_NAME_MAX_LENGTH,
  VOICE_PROFILE_NAME_MIN_LENGTH,
} from '../../domain/voice/profile';
import {
  REFERENCE_SAMPLE_CONSTRAINT_REQUIREMENT,
  REFERENCE_SAMPLE_DURATION_MS_MAX,
  REFERENCE_SAMPLE_DURATION_MS_MIN,
  REFERENCE_SAMPLE_FORMATS,
  REFERENCE_SAMPLE_SAMPLE_RATE_MIN,
  REFERENCE_SAMPLE_SPEECH_RATIO_MIN,
  type ReferenceSampleConstraint,
} from '../../domain/voice/reference-sample';
import { GenerationError } from '../generation/errors';

/** Requirement 26.4's 허용값, echoed on every sample rejection. */
export const REFERENCE_SAMPLE_ALLOWANCE = {
  durationMsMin: REFERENCE_SAMPLE_DURATION_MS_MIN,
  durationMsMax: REFERENCE_SAMPLE_DURATION_MS_MAX,
  formats: REFERENCE_SAMPLE_FORMATS,
  sampleRateMin: REFERENCE_SAMPLE_SAMPLE_RATE_MIN,
  speechRatioMin: REFERENCE_SAMPLE_SPEECH_RATIO_MIN,
} as const;

export const VOICE_PROFILE_ALLOWANCE = {
  nameMinLength: VOICE_PROFILE_NAME_MIN_LENGTH,
  nameMaxLength: VOICE_PROFILE_NAME_MAX_LENGTH,
  referenceSampleCountMin: REFERENCE_SAMPLE_COUNT_MIN,
  referenceSampleCountMax: REFERENCE_SAMPLE_COUNT_MAX,
} as const;

/** Requirements 26.1, 26.7, and an unknown catalogue voice for a `preset` profile. */
export function voiceProfileRequestInvalid(detail: {
  readonly violations: readonly SongFieldViolation[];
  readonly requirements: readonly string[];
}): GenerationError {
  return new GenerationError(
    400,
    'voice_profile_request_invalid',
    detail.violations.map(describeViolation).join('; '),
    {
      violations: detail.violations,
      requirements: detail.requirements,
      allowance: VOICE_PROFILE_ALLOWANCE,
    },
  );
}

/**
 * Requirements 26.4, 26.5 — the violated constraint names with their allowed values.
 *
 * `speechRatio` is reported separately from the violation list because 26.5 asks for "측정된 비율과
 * 최소 요구 비율" by name, and a `range` allowance carrying the minimum does not also carry the
 * measurement in a place a client would look for it. `uploadsDiscarded` states the other half of
 * 26.13's discipline: nothing that failed validation was kept.
 */
export function referenceSampleRejected(detail: {
  readonly uploadId: string;
  readonly violations: readonly SongFieldViolation[];
  readonly constraints: readonly ReferenceSampleConstraint[];
  readonly speechRatio: number | null;
  readonly uploadsDiscarded: boolean;
}): GenerationError {
  return new GenerationError(
    400,
    'voice_reference_sample_rejected',
    detail.violations.map(describeViolation).join('; '),
    {
      uploadId: detail.uploadId,
      violations: detail.violations,
      constraints: detail.constraints,
      requirements: detail.constraints.map(
        (constraint) => REFERENCE_SAMPLE_CONSTRAINT_REQUIREMENT[constraint],
      ),
      measuredSpeechRatio: detail.speechRatio,
      minimumSpeechRatio: REFERENCE_SAMPLE_SPEECH_RATIO_MIN,
      allowance: REFERENCE_SAMPLE_ALLOWANCE,
      uploadsDiscarded: detail.uploadsDiscarded,
    },
  );
}

export function referenceSampleUnreadable(
  uploadId: string,
  probeDetail: string,
): GenerationError {
  return new GenerationError(
    400,
    'voice_reference_sample_unreadable',
    'The uploaded reference sample could not be read as an audio file this service supports.',
    {
      uploadId,
      detail: probeDetail,
      allowance: REFERENCE_SAMPLE_ALLOWANCE,
      uploadsDiscarded: true,
    },
  );
}

/**
 * Requirement 26.25 — the conversion's length left the permitted window.
 *
 * 422, because nothing about the request was wrong: the engine returned audio of the wrong length.
 * The verdict travels whole, so a client sees the measured error, the tolerance and the
 * Quality_Threshold_Set version it was judged against (Requirement 34.6) rather than a bare
 * refusal.
 */
export function voiceConversionLengthUnmet(detail: {
  readonly jobId: string;
  readonly voiceProfileId: string;
  readonly verdict: ConversionLengthVerdict;
  readonly refundedAmount: number;
}): GenerationError {
  return new GenerationError(
    422,
    'voice_conversion_length_unmet',
    `the converted audio is ${String(Math.round(detail.verdict.errorMs))} ms from the source, outside ±${String(detail.verdict.toleranceMs)} ms`,
    {
      jobId: detail.jobId,
      voiceProfileId: detail.voiceProfileId,
      errorMs: detail.verdict.errorMs,
      toleranceMs: detail.verdict.toleranceMs,
      sourceDurationMs: detail.verdict.sourceDurationMs,
      outputDurationMs: detail.verdict.outputDurationMs,
      qualityThresholdSetVersion: detail.verdict.qualityThresholdSetVersion,
      refundedAmount: detail.refundedAmount,
      requirements: ['26.25'],
    },
  );
}

export function voiceConversionFailed(detail: {
  readonly jobId: string | null;
  readonly voiceProfileId: string;
  readonly failure: import('../../domain/generation-job/failure').JobFailure | null;
}): GenerationError {
  return new GenerationError(
    422,
    'voice_conversion_failed',
    'The voice conversion engine produced no audio.',
    {
      jobId: detail.jobId,
      voiceProfileId: detail.voiceProfileId,
      partialAudioStored: false,
      ...(detail.failure === null ? {} : { failure: detail.failure }),
    },
  );
}

export function voiceConversionSourceNotFound(sourceAssetId: string): GenerationError {
  return new GenerationError(
    404,
    'voice_conversion_source_not_found',
    'No such source Audio_Asset exists.',
    { sourceAssetId },
  );
}
