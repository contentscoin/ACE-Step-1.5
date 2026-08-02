/**
 * Requirement 6.3 — record the failure event in the Audit_Log.
 *
 * Uses the existing `AuditSinkPort` from task 1.3 and the existing append-only
 * `audit_log` table from task 1.1. The only addition is the `generation_job_failed`
 * event type in `domain/audit-log/entry.ts`, which needs no migration because
 * `audit_log.event_type` is `text` (0008_audit_log.sql).
 *
 * The entry records the failure and the refund, not the submitted prompt. A
 * failure is not a reason to copy user content into a table that cannot later be
 * corrected — the same restraint `services/moderation/audit.ts` applies.
 */

import type { AuditLogDraft } from '../../domain/audit-log/entry';
import type { JobFailure } from '../../domain/generation-job/failure';

export interface JobFailureAuditInput {
  readonly jobId: string;
  readonly accountId: string;
  readonly engineId: string;
  readonly engineJobId: string | null;
  readonly failure: JobFailure;
  /** Requirement 6.2/6.3: how many re-requests were spent before giving up. */
  readonly attemptsMade: number;
  /** Requirements 5.8/6.3: the amount returned to the balance. */
  readonly refundedAmount: number;
  readonly eventTimeMs: number;
}

export function jobFailedDraft(input: JobFailureAuditInput): AuditLogDraft {
  return {
    eventType: 'generation_job_failed',
    actorId: input.accountId,
    targetId: input.jobId,
    beforeValue: null,
    afterValue: {
      engineId: input.engineId,
      engineJobId: input.engineJobId,
      classification: input.failure.classification,
      reason: input.failure.reason,
      retryable: input.failure.retryable,
      detail: input.failure.detail,
      attemptsMade: input.attemptsMade,
      refundedAmount: input.refundedAmount,
    },
    eventTime: new Date(input.eventTimeMs),
  };
}
