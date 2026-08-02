/**
 * The Sound_Pack_Service's rejections.
 *
 * All three are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no
 * new branch and `details` reaches the client inside the `error` object — the contract
 * Requirements 3.5/4.6, 22.3/22.18 and 21.18 already use.
 *
 * - `soundPackRequestInvalid` is Requirement 24.20: the violated field names, the input
 *   lengths and the permitted ranges, as data. 400, because the request was wrong.
 * - `soundPackCueUnknown` is the guard on Requirement 24.17's single-cue regeneration. A cue
 *   name outside the taxonomy is not a generation failure and must not consume a retry
 *   budget, so it is rejected before anything is submitted. 404, because the named cue does
 *   not exist — 400 would suggest a malformed request rather than a wrong name.
 * - `soundPackExportFailed` is Requirement 24.10's negative case, including the budget. 500
 *   rather than 422: nothing about the request was wrong and the user cannot fix it by asking
 *   differently. That is the distinction 21.18's 422 turns on — a quality miss is a fact
 *   about generated audio the user might regenerate, while a 154-file archive or an export
 *   that took 70 seconds is the service failing to do what it promised.
 *
 * There is deliberately **no** error for a pack that came back incomplete or needing review.
 * Requirements 24.3, 24.21 and 24.22 all require that the cues which succeeded be *kept* and
 * that the caller be told what is wrong — so those are a successful response describing a
 * flawed pack, not a failure. Throwing would discard up to 77 cues the user paid for.
 */

import {
  PACK_CUE_COUNT,
  PACK_DESCRIPTION_MAX_LENGTH,
  PACK_DESCRIPTION_MIN_LENGTH,
  PACK_EXPORT_FILE_COUNT,
  PACK_NAME_MAX_LENGTH,
  PACK_NAME_MIN_LENGTH,
} from '../../domain/sound-pack/bounds';
import {
  PACK_EXPORT_FAULT_REQUIREMENT,
  type PackExportVerdict,
} from '../../domain/sound-pack/export';
import type { SoundPackFieldLength } from '../../domain/sound-pack/validation';
import { describeViolation, type SongFieldViolation } from '../../domain/song/violation';
import { GenerationError } from '../generation/errors';

export interface SoundPackRequestInvalidDetail {
  readonly violations: readonly SongFieldViolation[];
  /** Requirement 24.20's "입력 길이", one per violated field. */
  readonly lengths: readonly SoundPackFieldLength[];
}

export function soundPackRequestInvalid(detail: SoundPackRequestInvalidDetail): GenerationError {
  return new GenerationError(
    400,
    'sound_pack_request_invalid',
    detail.violations.map(describeViolation).join('; '),
    {
      violations: detail.violations,
      lengths: detail.lengths,
      allowance: {
        name: { minLength: PACK_NAME_MIN_LENGTH, maxLength: PACK_NAME_MAX_LENGTH },
        description: {
          minLength: PACK_DESCRIPTION_MIN_LENGTH,
          maxLength: PACK_DESCRIPTION_MAX_LENGTH,
        },
      },
    },
  );
}

export function soundPackCueUnknown(cueName: string): GenerationError {
  return new GenerationError(
    404,
    'sound_pack_cue_unknown',
    `${cueName} is not a Semantic_Cue name.`,
    { cueName, cueCount: PACK_CUE_COUNT },
  );
}

export function soundPackExportFailed(verdict: PackExportVerdict): GenerationError {
  return new GenerationError(
    500,
    'sound_pack_export_failed',
    `Sound pack export produced ${String(verdict.fileCount)} of ${String(PACK_EXPORT_FILE_COUNT)} files in ${String(verdict.elapsedMs)} ms.`,
    {
      faults: verdict.faults,
      requirements: verdict.faults.map((fault) => PACK_EXPORT_FAULT_REQUIREMENT[fault]),
      fileCount: verdict.fileCount,
      requiredFileCount: PACK_EXPORT_FILE_COUNT,
      elapsedMs: verdict.elapsedMs,
      budgetMs: verdict.budgetMs,
      qualityThresholdSetVersion: verdict.qualityThresholdSetVersion,
    },
  );
}
