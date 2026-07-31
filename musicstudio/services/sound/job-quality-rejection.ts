/**
 * Requirement 21.18's terminal step, over the existing job machinery.
 *
 * "해당 Generation_Job을 실패로 종료하며 차감된 크레딧 전액을 환급" is not a new
 * mechanism — it is the `engine_failed` transition the lifecycle already defines, whose
 * effect set already includes a full refund and an Audit_Log entry. So this module adds
 * no refund logic and no state machine: it looks the job up, names the failure, and
 * hands it to `applyJobEvent`, the one place a job changes state.
 *
 * Consequences of reusing that path, all of them wanted:
 *
 * - the refund goes through `runtime.refunds`, the same `CreditRefundPort` as
 *   Requirements 5.7, 5.8, 6.3 and 20.15;
 * - it refunds `record.debitedAmount`, which is the full debit by construction;
 * - a job already terminal absorbs the event, so a quality rejection racing the
 *   Requirement 5.8 timeout sweep cannot refund twice;
 * - the Requirement 5.4 status push and the failure audit entry happen without this
 *   module arranging either.
 */

import { jobFailure } from '../../domain/generation-job/failure';
import { applyJobEvent } from '../generation/job-transitions';
import type { JobRuntime } from '../generation/runtime';

import type {
  BgmQualityRejection,
  BgmQualityRejectionPort,
  BgmQualityRejectionResult,
} from './bgm-ports';
import type { SfxQualityRejection, SfxQualityRejectionPort } from './sfx-ports';
import type { V2aQualityRejection, V2aQualityRejectionPort } from './v2a-ports';

/**
 * The rejection path, satisfying all three sound services' ports.
 *
 * The implementation reads exactly two things off a rejection — the job identifier and the
 * unmet criterion names, which it joins into the failure detail — and neither depends on
 * *which* criteria they are. So Requirement 21.18's loop criteria, Requirements 22.14/22.15's
 * SFX criteria and Requirements 23.8/23.9/23.12/23.17's foley criteria go through the same
 * function, and the intersection return type is how that is said in the type system rather
 * than in a comment. Three ports, one refund path.
 *
 * An empty `unmet` list is legitimate and means "failed for a reason that is not a criterion
 * miss" — Requirement 23.17's timeout is the case. The failure detail is then the criterion
 * name list's empty string, and the reason code is still `loop_quality_unmet`, which is the
 * only reason code the lifecycle vocabulary has for "this service ended the job itself". See
 * the note in `services/sound/v2a-service.ts`; adding a reason code would be a change to
 * `domain/generation-job/failure.ts` that Requirement 23 does not ask for.
 */
export function createJobQualityRejection(
  runtime: JobRuntime,
): BgmQualityRejectionPort & SfxQualityRejectionPort & V2aQualityRejectionPort {
  return {
    async reject(
      rejection: BgmQualityRejection | SfxQualityRejection | V2aQualityRejection,
    ): Promise<BgmQualityRejectionResult> {
      const record = await runtime.store.find(rejection.jobId);
      // A job that no longer exists cannot be failed, and inventing a refund for it
      // would credit an account for work nobody can account for.
      if (record === undefined) return { refundedAmount: 0 };

      const applied = await applyJobEvent(runtime, record, {
        kind: 'engine_failed',
        // The unmet criterion names travel as the failure detail so the Audit_Log entry
        // Requirement 6.3 writes says *which* criteria failed, not merely that quality
        // did. `detail` is engine diagnosis text elsewhere; here it is ours.
        failure: jobFailure('engine_error', 'loop_quality_unmet', rejection.unmet.join(',')),
      });

      // `refundCredits` is false when the event was absorbed by an already-terminal
      // job, in which case the refund it owed was settled by whoever terminated it.
      return {
        refundedAmount: applied.transition.effects.refundCredits ? record.debitedAmount : 0,
      };
    },
  };
}
