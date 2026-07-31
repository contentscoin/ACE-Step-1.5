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

export function createJobQualityRejection(runtime: JobRuntime): BgmQualityRejectionPort {
  return {
    async reject(rejection: BgmQualityRejection): Promise<BgmQualityRejectionResult> {
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
