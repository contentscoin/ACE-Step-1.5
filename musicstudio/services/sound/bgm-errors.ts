/**
 * The BGM_Service's two rejections.
 *
 * Both are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no
 * new branch and `details` reaches the client inside the `error` object — the same
 * contract Requirements 3.5/4.6 and 7.2/7.4 already use.
 *
 * - `bgmRequestInvalid` is Requirement 21.3: the violated field names with their
 *   permitted minimum and maximum, carried as data. It shares
 *   `domain/song/violation.ts`'s vocabulary rather than inventing a parallel one,
 *   because 21.3 asks for exactly what a `range` or `length` allowance already holds.
 * - `bgmLoopQualityUnmet` is Requirement 21.18: three attempts spent, the names of the
 *   unmet criteria, and the amount refunded. 422 rather than 400, because nothing about
 *   the request was wrong — the engine could not meet the criteria for it.
 */

import {
  LADDER_INVARIANT_REQUIREMENT,
  type IntensityLadderInvariant,
} from '../../domain/bgm/intensity-ladder';
import type { LoopSeamCriterion } from '../../domain/bgm/loop-seam';
import { describeUnmetCriteria } from '../../domain/bgm/loop-seam';
import type { SongFieldViolation } from '../../domain/song/violation';
import { describeViolation } from '../../domain/song/violation';
import { GenerationError } from '../generation/errors';

export function bgmRequestInvalid(violations: readonly SongFieldViolation[]): GenerationError {
  return new GenerationError(
    400,
    'bgm_request_invalid',
    violations.map(describeViolation).join('; '),
    { violations },
  );
}

export interface BgmLoopQualityDetail {
  readonly unmet: readonly LoopSeamCriterion[];
  readonly attempts: number;
  readonly refundedAmount: number;
  readonly qualityThresholdSetVersion: number;
}

export function bgmLoopQualityUnmet(detail: BgmLoopQualityDetail): GenerationError {
  return new GenerationError(
    422,
    'bgm_loop_quality_unmet',
    `The loop did not meet ${String(detail.unmet.length)} continuity criteria in ${String(detail.attempts)} attempts.`,
    {
      unmet: detail.unmet,
      criteria: describeUnmetCriteria(detail.unmet),
      attempts: detail.attempts,
      refundedAmount: detail.refundedAmount,
      qualityThresholdSetVersion: detail.qualityThresholdSetVersion,
    },
  );
}


export interface BgmIntensityLadderDetail {
  readonly unmet: readonly IntensityLadderInvariant[];
  readonly gapsLufs: readonly number[];
  readonly durationSpreadMs: number;
}

/**
 * Requirements 21.10 and 21.11 violated by what was produced.
 *
 * Reported rather than repaired. Requirement 21.18 gives the loop criteria an explicit
 * remedy — regenerate with a different seed, up to twice — and gives none to the
 * intensity invariants, so a service that invented one would be writing requirement
 * text. Closing the loudness gap is loudness normalisation, which is Requirement
 * 30.2–30.5 and task 3.3's Mastering_Assistant.
 */
export function bgmIntensityLadderUnmet(detail: BgmIntensityLadderDetail): GenerationError {
  return new GenerationError(
    422,
    'bgm_intensity_ladder_unmet',
    `The produced intensity variants violate ${String(detail.unmet.length)} invariants.`,
    {
      unmet: detail.unmet,
      requirements: detail.unmet.map((invariant) => LADDER_INVARIANT_REQUIREMENT[invariant]),
      gapsLufs: detail.gapsLufs,
      durationSpreadMs: detail.durationSpreadMs,
    },
  );
}
