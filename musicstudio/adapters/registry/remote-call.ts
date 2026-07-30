/**
 * Remote engine call budget and its timeout consequence (Requirements 20.14,
 * 20.15).
 *
 * 20.14 caps a remote call at 300 seconds. 20.15 then requires three things on
 * timeout: the Generation_Job becomes a timeout failure, the full debited amount
 * is refunded within 60 seconds, and the engine id plus the timeout reason are
 * recorded on the job.
 *
 * The job state transition itself belongs to Job_Orchestrator (task 1.5), so this
 * module produces the *record* 1.5 will store and drives the refund through the
 * narrow `CreditRefundPort`. The 60-second bound is expressed as an explicit
 * `refundDeadlineMs` on the refund request rather than as a timer, so it is a
 * value the orchestrator and its tests can assert instead of a race to observe.
 */

import { REMOTE_CALL_TIMEOUT_MS, type TimeoutRunner } from '../timeout-runner';
import type { Clock } from '../../services/clock';

import type { CreditRefundPort } from './ports';

export const REFUND_DEADLINE_MS = 60_000;

export interface RemoteCallContext {
  readonly engineId: string;
  readonly accountId: string;
  readonly jobId: string;
  /** Credits already debited for this job; 20.15 refunds all of them. */
  readonly debitedAmount: number;
}

/** Job record fields Requirement 20.15 requires on a timeout. */
export interface RemoteTimeoutRecord {
  readonly engineId: string;
  readonly reason: 'engine_timeout';
  readonly budgetMs: number;
  readonly failedAtMs: number;
  readonly refundDeadlineMs: number;
  readonly refundedAmount: number;
}

export type RemoteCallOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'failed'; readonly engineId: string; readonly reason: string }
  | { readonly kind: 'timed_out'; readonly record: RemoteTimeoutRecord };

export interface RemoteCallDependencies {
  readonly timeoutRunner: TimeoutRunner;
  readonly clock: Clock;
  readonly refunds: CreditRefundPort;
  /** Override only for tests of the bound itself. */
  readonly budgetMs?: number;
}

export async function callRemoteEngine<T>(
  operation: () => Promise<T>,
  context: RemoteCallContext,
  deps: RemoteCallDependencies,
): Promise<RemoteCallOutcome<T>> {
  const budgetMs = deps.budgetMs ?? REMOTE_CALL_TIMEOUT_MS;
  const outcome = await deps.timeoutRunner.run(operation, budgetMs);

  if (outcome.kind === 'completed') {
    return { kind: 'completed', value: outcome.value };
  }

  if (outcome.kind === 'failed') {
    return {
      kind: 'failed',
      engineId: context.engineId,
      reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    };
  }

  const failedAtMs = deps.clock.now().getTime();
  const record: RemoteTimeoutRecord = {
    engineId: context.engineId,
    reason: 'engine_timeout',
    budgetMs,
    failedAtMs,
    refundDeadlineMs: failedAtMs + REFUND_DEADLINE_MS,
    refundedAmount: context.debitedAmount,
  };

  await deps.refunds.refund({
    accountId: context.accountId,
    jobId: context.jobId,
    engineId: context.engineId,
    reason: record.reason,
    amount: context.debitedAmount,
    refundDeadlineMs: record.refundDeadlineMs,
  });

  return { kind: 'timed_out', record };
}
