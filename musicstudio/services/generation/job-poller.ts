/**
 * Status polling (Requirements 5.2, 5.3, 5.6, 5.8, 6.5; design §2.3).
 *
 * One poll does four things, in this order and no other:
 *
 * 1. Checks the Requirement 5.8 deadline *before* contacting the engine, so a job
 *    whose engine reports status 0 forever still becomes a timeout failure.
 * 2. Polls through `callRemoteEngine`, which applies the Requirement 20.14 cap.
 * 3. Translates the status through `engine-status.ts` (Requirement 5.3) and, on
 *    success, fetches and publishes the results (Requirement 5.6) *before*
 *    recording the success — so a job never reports `succeeded` with no assets.
 * 4. Feeds the resulting event to `applyJobEvent`, the single transition point.
 *
 * A connection failure is Requirement 6.5, not Requirement 6.1: the job stays
 * non-terminal and the next poll is scheduled inside the 60-second bound. That
 * distinction is made by the lifecycle function, not here.
 */

import type { EngineAdapter } from '../../adapters/engine-adapter';
import { ENGINE_JOB_STATE, type EngineJobHandle } from '../../adapters/engine-job';
import { normalizeEngineResult } from '../../adapters/normalized-generation';
import type { ScheduledTask } from '../../adapters/registry/health-schedule';
import { callRemoteEngine, type RemoteCallContext } from '../../adapters/registry/remote-call';
import { derivationTypeForEditKind } from '../../domain/edit/edit-kind';
import { classifyEngineFailure, jobFailure } from '../../domain/generation-job/failure';
import { isTerminalGenerationJobState } from '../../domain/generation-job/lifecycle';
import { nextPollDelayMs } from '../../domain/generation-job/poll-schedule';
import { isJobTimedOut } from '../../domain/generation-job/timeout';

import { lifecycleEventFor } from './engine-status';
import type { GenerationJobRecord } from './job-record';
import { applyJobEvent, type AppliedJobEvent } from './job-transitions';
import type { JobRuntime } from './runtime';

export type PollResult =
  | { readonly kind: 'skipped'; readonly reason: 'unknown_job' | 'terminal' | 'not_submitted' }
  | { readonly kind: 'applied'; readonly applied: AppliedJobEvent };

export async function pollJobOnce(runtime: JobRuntime, jobId: string): Promise<PollResult> {
  const record = await runtime.store.find(jobId);
  if (record === undefined) return { kind: 'skipped', reason: 'unknown_job' };
  if (isTerminalGenerationJobState(record.lifecycle.state)) {
    return { kind: 'skipped', reason: 'terminal' };
  }
  if (record.engineJobId === null) return { kind: 'skipped', reason: 'not_submitted' };

  // Requirement 5.8 is checked first: an engine that answers promptly with "still
  // running" must not keep the job alive past its budget.
  const nowMs = runtime.clock.now().getTime();
  if (isJobTimedOut(record.acceptedAtMs, nowMs)) {
    return { kind: 'applied', applied: await applyJobEvent(runtime, record, { kind: 'timeout_elapsed' }) };
  }

  const adapter = runtime.registry.require(record.engineId).adapter;
  const handle = handleFor(record);
  const context = remoteContextFor(record);

  const polled = await callRemoteEngine(() => adapter.poll(handle), context, {
    timeoutRunner: runtime.timeoutRunner,
    clock: runtime.clock,
    refunds: runtime.refunds,
  });

  if (polled.kind === 'timed_out') {
    return {
      kind: 'applied',
      applied: await applyJobEvent(
        runtime,
        record,
        { kind: 'engine_failed', failure: jobFailure('engine_error', 'engine_timeout', null) },
        { refundSettledElsewhere: true },
      ),
    };
  }

  if (polled.kind === 'failed') {
    // Requirement 6.5: unreachable, so keep the job and back off within 60 s.
    return {
      kind: 'applied',
      applied: await applyJobEvent(
        runtime,
        record,
        { kind: 'engine_unreachable', detail: polled.reason },
        { unreachableStreak: record.unreachableStreak + 1 },
      ),
    };
  }

  const status = polled.value;
  if (status.state !== ENGINE_JOB_STATE.succeeded) {
    return {
      kind: 'applied',
      applied: await applyJobEvent(runtime, record, lifecycleEventFor(status), {
        progressPercent: status.progressPercent ?? null,
        unreachableStreak: 0,
      }),
    };
  }

  return { kind: 'applied', applied: await completeJob(runtime, record, adapter, handle, context) };
}

/** Requirement 5.6: one Audio_Asset per result audio, before success is recorded. */
async function completeJob(
  runtime: JobRuntime,
  record: GenerationJobRecord,
  adapter: EngineAdapter,
  handle: EngineJobHandle,
  context: RemoteCallContext,
): Promise<AppliedJobEvent> {
  const fetched = await callRemoteEngine(() => adapter.fetchResult(handle), context, {
    timeoutRunner: runtime.timeoutRunner,
    clock: runtime.clock,
    refunds: runtime.refunds,
  });

  if (fetched.kind === 'timed_out') {
    return applyJobEvent(
      runtime,
      record,
      { kind: 'engine_failed', failure: jobFailure('engine_error', 'engine_timeout', null) },
      { refundSettledElsewhere: true },
    );
  }

  if (fetched.kind === 'failed') {
    return applyJobEvent(runtime, record, {
      kind: 'engine_failed',
      failure: classifyEngineFailure({ reason: fetched.reason }),
    });
  }

  const results = fetched.value.map((raw) =>
    normalizeEngineResult({
      assetKind: record.input.assetKind,
      engineId: record.engineId,
      jobState: ENGINE_JOB_STATE.succeeded,
      raw,
    }),
  );

  const edit = record.input.edit;
  const assetIds = await runtime.assets.publish({
    accountId: record.accountId,
    jobId: record.jobId,
    assetKind: record.input.assetKind,
    engineId: record.engineId,
    results,
    // Requirement 7.12: an Edit_Task's results derive from its source asset, and the
    // edit kind is the derivation. Both are read off the stored request rather than
    // recomputed, so a Requirement 6.4 retry records the same lineage.
    ...(edit === undefined
      ? {}
      : {
          sourceAssetIds: [edit.source.assetId],
          derivationType: derivationTypeForEditKind(edit.kind),
        }),
  });

  return applyJobEvent(runtime, record, { kind: 'engine_succeeded' }, { assetIds, progressPercent: 100 });
}

/**
 * Requirement 5.2: schedules the next poll and re-arms itself until the job is
 * terminal. The delay comes from `nextPollDelayMs`, which is 5 seconds normally and
 * the Requirement 6.5 backoff after a failed contact.
 */
export function schedulePolling(runtime: JobRuntime, jobId: string): ScheduledTask {
  let cancelled = false;
  let current: ScheduledTask | null = null;

  const arm = (delayMs: number): void => {
    if (cancelled) return;
    current = runtime.scheduler.after(delayMs, () => {
      void (async () => {
        const result = await pollJobOnce(runtime, jobId);
        if (cancelled) return;
        if (result.kind === 'skipped') return;
        if (isTerminalGenerationJobState(result.applied.record.lifecycle.state)) return;
        arm(nextPollDelayMs(result.applied.record.unreachableStreak));
      })();
    });
  };

  arm(nextPollDelayMs(0));

  return {
    cancel: () => {
      cancelled = true;
      current?.cancel();
    },
  };
}

function handleFor(record: GenerationJobRecord): EngineJobHandle {
  return {
    engineId: record.engineId,
    engineJobId: record.engineJobId ?? '',
    submittedAtMs: record.acceptedAtMs,
  };
}

function remoteContextFor(record: GenerationJobRecord): RemoteCallContext {
  return {
    engineId: record.engineId,
    accountId: record.accountId,
    jobId: record.jobId,
    debitedAmount: record.debitedAmount,
  };
}
