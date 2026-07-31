/**
 * The user-facing view of a job (Requirements 5.1, 5.3, 5.5, 6.1).
 *
 * One projection serves both the status query and the SSE payload, so a client
 * polling the REST endpoint and a client watching the stream cannot be shown
 * different answers to the same question.
 *
 * The state is always the lifecycle state — a Requirement 5.3 name, never an
 * engine status code. The queue position and the ETA are read at projection time
 * rather than stored, because both change as other jobs move.
 */

import { estimateCompletion } from '../../domain/generation-job/eta';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { GenerationJobState } from '../../domain/generation-job/lifecycle';
import { jobDeadlineMs } from '../../domain/generation-job/timeout';

import { deliveryDeadlineMs, type JobStatusEvent } from './job-events';
import type { GenerationJobRecord } from './job-record';
import type { JobRuntime } from './runtime';

export interface JobStatusView {
  readonly jobId: string;
  /** Requirement 5.3. */
  readonly state: GenerationJobState;
  readonly engineId: string;
  /** Requirement 5.1. */
  readonly engineJobId: string | null;
  readonly progressPercent: number | null;
  /** Requirement 5.1: 1-based; `null` once the job is no longer waiting. */
  readonly queuePosition: number | null;
  /** Requirement 5.5. */
  readonly estimatedCompletionAtMs: number | null;
  /** Requirement 6.1: classification plus retryability. */
  readonly failure: JobFailure | null;
  /** Requirement 5.6. */
  readonly assetIds: readonly string[];
  readonly acceptedAtMs: number;
  /** Requirement 5.8: when the sweep will fail this job if it is still running. */
  readonly deadlineAtMs: number;
  readonly attemptsMade: number;
  /** Requirement 6.4. */
  readonly retryOfJobId: string | null;
}

export async function jobStatusView(
  runtime: JobRuntime,
  record: GenerationJobRecord,
): Promise<JobStatusView> {
  const nowMs = runtime.clock.now().getTime();
  const queuePosition = await runtime.queue.positionOf(record.jobId);

  return {
    jobId: record.jobId,
    state: record.lifecycle.state,
    engineId: record.engineId,
    engineJobId: record.engineJobId,
    progressPercent: record.progressPercent,
    queuePosition,
    estimatedCompletionAtMs: etaFor(runtime, record, queuePosition, nowMs),
    failure: record.lifecycle.failure,
    assetIds: record.assetIds,
    acceptedAtMs: record.acceptedAtMs,
    deadlineAtMs: jobDeadlineMs(record.acceptedAtMs),
    attemptsMade: record.attemptsMade,
    retryOfJobId: record.retryOfJobId,
  };
}

export async function jobStatusEvent(
  runtime: JobRuntime,
  record: GenerationJobRecord,
): Promise<JobStatusEvent> {
  const emittedAtMs = runtime.clock.now().getTime();
  const queuePosition = await runtime.queue.positionOf(record.jobId);

  return {
    jobId: record.jobId,
    accountId: record.accountId,
    state: record.lifecycle.state,
    progressPercent: record.progressPercent,
    queuePosition,
    estimatedCompletionAtMs: etaFor(runtime, record, queuePosition, emittedAtMs),
    failure: record.lifecycle.failure,
    assetIds: record.assetIds,
    emittedAtMs,
    deliverByMs: deliveryDeadlineMs(emittedAtMs),
    sequence: record.eventSequence,
  };
}

/**
 * Requirement 5.5 applies WHILE the job is pending, which is exactly when the
 * queue still reports a position. A job already running has no queue wait left to
 * estimate from, so the answer is `null` rather than a stale figure.
 */
function etaFor(
  runtime: JobRuntime,
  record: GenerationJobRecord,
  queuePosition: number | null,
  nowMs: number,
): number | null {
  if (record.lifecycle.state !== 'pending' || queuePosition === null) return null;

  const averageDurationMs = runtime.statistics.averageDurationMs(record.engineId);
  if (averageDurationMs === null) return null;

  return estimateCompletion({ queuePosition, averageDurationMs, nowMs })?.estimatedCompletionAtMs ?? null;
}
