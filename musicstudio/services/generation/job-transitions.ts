/**
 * The one place a Generation_Job changes state.
 *
 * `domain/generation-job/lifecycle.ts` decides *what* a transition owes; this
 * module performs it. Every path — polling, cancellation, the 900 s sweep, an
 * exhausted retry budget — goes through this function, which is why the refund of
 * Requirements 5.7/5.8/6.3 happens exactly once per job: the effect set comes from
 * a pure function that reports nothing at all for an event against an already
 * terminal job.
 *
 * The refund uses the same `CreditRefundPort` and the same 60-second
 * `refundDeadlineMs` convention as the Requirement 20.15 remote-call timeout, so
 * the two timeout mechanisms share one refund path rather than competing.
 */

import { REFUND_DEADLINE_MS } from '../../adapters/registry/remote-call';
import {
  applyJobLifecycleEvent,
  isTerminalGenerationJobState,
  type JobLifecycleEvent,
  type JobLifecycleTransition,
} from '../../domain/generation-job/lifecycle';

import { jobFailedDraft } from './audit';
import { jobStatusEvent } from './job-status';
import type { GenerationJobRecord } from './job-record';
import type { JobRuntime } from './runtime';

export interface ApplyJobEventOptions {
  /** Requirement 5.6: identifiers of the assets created from the results. */
  readonly assetIds?: readonly string[];
  readonly progressPercent?: number | null;
  /** Requirement 5.1: set once the engine answers the submit. */
  readonly engineJobId?: string | null;
  /** Requirement 6.2: re-requests spent so far. */
  readonly attemptsMade?: number;
  /** Requirement 6.5: consecutive contact failures. */
  readonly unreachableStreak?: number;
  /**
   * Set when Requirement 20.15 has already returned the credits for this job.
   *
   * The transition still *owes* a refund — that is a property of becoming failed,
   * not of who noticed — but the obligation is already met, so issuing a second
   * one would double-credit the account. `callRemoteEngine` is the only producer
   * of this flag, and `test/unit/generation/job-orchestrator.test.ts` pins that a
   * remote-call timeout results in exactly one refund request.
   */
  readonly refundSettledElsewhere?: boolean;
}

export interface AppliedJobEvent {
  readonly record: GenerationJobRecord;
  readonly transition: JobLifecycleTransition;
}

export async function applyJobEvent(
  runtime: JobRuntime,
  record: GenerationJobRecord,
  event: JobLifecycleEvent,
  options: ApplyJobEventOptions = {},
): Promise<AppliedJobEvent> {
  const transition = applyJobLifecycleEvent(record.lifecycle, event);
  const nowMs = runtime.clock.now().getTime();
  const next = patched(record, transition, options, nowMs);

  // The waiting list holds pending jobs only, so anything terminal (and anything
  // that started running) leaves it. Removal precedes the notification so the
  // published queue position agrees with the published state.
  if (isTerminalGenerationJobState(next.lifecycle.state) || next.lifecycle.state === 'running') {
    await runtime.queue.remove(next.jobId);
  }

  if (transition.effects.refundCredits && options.refundSettledElsewhere !== true) {
    await runtime.refunds.refund({
      accountId: next.accountId,
      jobId: next.jobId,
      engineId: next.engineId,
      reason: next.lifecycle.failure?.reason ?? 'cancelled_by_owner',
      amount: next.debitedAmount,
      refundDeadlineMs: nowMs + REFUND_DEADLINE_MS,
    });
  }

  if (transition.effects.auditFailure && next.lifecycle.failure !== null) {
    runtime.audit.record(
      jobFailedDraft({
        jobId: next.jobId,
        accountId: next.accountId,
        engineId: next.engineId,
        engineJobId: next.engineJobId,
        failure: next.lifecycle.failure,
        attemptsMade: next.attemptsMade,
        refundedAmount: next.debitedAmount,
        eventTimeMs: nowMs,
      }),
    );
  }

  await runtime.store.save(next);

  // Requirement 5.4: published synchronously inside the transition, so nothing
  // sits between the state change and the write to the open connection.
  if (transition.effects.notifyClients) {
    runtime.events.publish(await jobStatusEvent(runtime, next));
  }

  return { record: next, transition };
}

function patched(
  record: GenerationJobRecord,
  transition: JobLifecycleTransition,
  options: ApplyJobEventOptions,
  nowMs: number,
): GenerationJobRecord {
  return {
    ...record,
    lifecycle: transition.lifecycle,
    updatedAtMs: nowMs,
    engineJobId: options.engineJobId ?? record.engineJobId,
    progressPercent:
      options.progressPercent === undefined ? record.progressPercent : options.progressPercent,
    attemptsMade: options.attemptsMade ?? record.attemptsMade,
    unreachableStreak: options.unreachableStreak ?? record.unreachableStreak,
    assetIds: transition.effects.publishResults ? (options.assetIds ?? []) : record.assetIds,
    eventSequence: transition.effects.notifyClients
      ? record.eventSequence + 1
      : record.eventSequence,
  };
}
