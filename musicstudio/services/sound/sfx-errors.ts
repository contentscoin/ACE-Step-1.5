/**
 * The SFX_Service's two rejections.
 *
 * Both are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no new
 * branch and `details` reaches the client inside the `error` object — the same contract
 * Requirements 3.5/4.6, 7.2/7.4 and 21.3/21.18 already use.
 *
 * - `sfxRequestInvalid` is Requirements 22.3 and 22.18: the violated constraint names with the
 *   input values and permitted ranges, carried as data. It shares
 *   `domain/song/violation.ts`'s vocabulary rather than inventing a parallel one, and carries
 *   the prompt's character and token counts alongside, which is the one thing 22.3 asks for
 *   that a `length` allowance cannot hold.
 * - `sfxAllVariantsFailed` covers the case Requirement 22.19 does not: 22.19 legislates for
 *   *some* variants failing, and says nothing about all of them. Modelled on 21.18's
 *   `bgm_loop_quality_unmet` — 422, because nothing about the request was wrong — with the
 *   failure reasons and the total refunded.
 */

import { SFX_PROMPT_MAX_TOKENS, SFX_PROMPT_MIN_LENGTH } from '../../domain/sfx/bounds';
import type { SfxPromptViolation } from '../../domain/sfx/validation';
import type { SongFieldViolation } from '../../domain/song/violation';
import { describeViolation } from '../../domain/song/violation';
import { GenerationError } from '../generation/errors';

import {
  SFX_QUALITY_CRITERION_REQUIREMENT,
  type FailedSfxVariant,
} from './sfx-result';

export interface SfxRequestInvalidDetail {
  readonly violations: readonly SongFieldViolation[];
  /** Requirement 22.3's character and token counts. `null` when the prompt was fine. */
  readonly prompt: SfxPromptViolation | null;
}

export function sfxRequestInvalid(detail: SfxRequestInvalidDetail): GenerationError {
  return new GenerationError(
    400,
    'sfx_request_invalid',
    detail.violations.map(describeViolation).join('; '),
    {
      violations: detail.violations,
      ...(detail.prompt === null ? {} : { prompt: detail.prompt }),
      promptAllowance: { minLength: SFX_PROMPT_MIN_LENGTH, maxTokens: SFX_PROMPT_MAX_TOKENS },
    },
  );
}

export interface SfxAllVariantsFailedDetail {
  readonly failures: readonly FailedSfxVariant[];
  readonly refundedAmount: number;
  readonly qualityThresholdSetVersion: number;
}

export function sfxAllVariantsFailed(detail: SfxAllVariantsFailedDetail): GenerationError {
  return new GenerationError(
    422,
    'sfx_all_variants_failed',
    `All ${String(detail.failures.length)} sound-effect variants failed.`,
    {
      failures: detail.failures.map((failure) => ({
        seed: failure.seed,
        jobId: failure.jobId,
        reason: failure.reason,
        unmet: failure.unmet,
        requirements: failure.unmet.map(
          (criterion) => SFX_QUALITY_CRITERION_REQUIREMENT[criterion],
        ),
      })),
      refundedAmount: detail.refundedAmount,
      qualityThresholdSetVersion: detail.qualityThresholdSetVersion,
    },
  );
}
