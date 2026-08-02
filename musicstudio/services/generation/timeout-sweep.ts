/**
 * The Requirement 5.8 timeout sweep.
 *
 * `pollJobOnce` already checks the deadline before each poll, so this sweep is the
 * safety net for the case that check cannot cover: a job whose polling loop stopped
 * — a gateway pod restarted, a scheduled task was lost — and which would otherwise
 * sit non-terminal forever with its credits still debited.
 *
 * Both routes end in the same `applyJobEvent` call with the same event, and the
 * lifecycle function absorbs the second one, so running the sweep alongside an
 * active poller cannot fail a job twice or refund twice.
 */

import { isJobTimedOut } from '../../domain/generation-job/timeout';

import type { GenerationJobRecord } from './job-record';
import { applyJobEvent } from './job-transitions';
import type { JobRuntime } from './runtime';

export interface SweepResult {
  readonly timedOutJobIds: readonly string[];
  readonly inspected: number;
}

export async function sweepTimedOutJobs(runtime: JobRuntime): Promise<SweepResult> {
  const nowMs = runtime.clock.now().getTime();
  const candidates = await runtime.store.nonTerminal();
  const timedOutJobIds: string[] = [];

  for (const record of candidates) {
    if (!isJobTimedOut(record.acceptedAtMs, nowMs)) continue;
    await applyJobEvent(runtime, record, { kind: 'timeout_elapsed' });
    timedOutJobIds.push(record.jobId);
  }

  return { timedOutJobIds, inspected: candidates.length };
}

/** Convenience predicate for callers building an operations view. */
export function isOverdue(record: GenerationJobRecord, nowMs: number): boolean {
  return isJobTimedOut(record.acceptedAtMs, nowMs);
}
