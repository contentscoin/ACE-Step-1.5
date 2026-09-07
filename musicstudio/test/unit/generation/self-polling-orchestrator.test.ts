import { describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../../adapters/engine-job';
import {
  SelfPollingJobOrchestrator,
  startTimeoutSweep,
} from '../../../services/generation/self-polling-orchestrator';
import { JOB_TIMEOUT_MS } from '../../../domain/generation-job/timeout';
import {
  createGenerationHarness,
  drainScheduler,
  submission,
} from '../../support/generation-harness';
import { flushAsync } from '../../support/registry-harness';

/**
 * The orchestrator a deployment constructs (slice S5).
 *
 * `JobOrchestrator` is tested through explicit `pollOnce` calls, which is right for the rules
 * and useless for the deployment: nothing in production called `schedulePolling`, so a submitted
 * job was never polled. These cases pin that this subclass does — and that it stops.
 */

function accepted(outcome: Awaited<ReturnType<SelfPollingJobOrchestrator['submit']>>): string {
  if (outcome.kind !== 'accepted') throw new Error(`expected acceptance, got ${outcome.kind}`);
  return outcome.acceptance.jobId;
}

describe('SelfPollingJobOrchestrator', () => {
  it('polls an accepted job until it is terminal, then lets the loop go', async () => {
    const harness = createGenerationHarness({ withSongGateway: false });
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime);
    harness.adapter.enqueuePoll(
      { state: ENGINE_JOB_STATE.running, progressPercent: 40 },
      { state: ENGINE_JOB_STATE.succeeded },
    );

    const jobId = accepted(await orchestrator.submit(submission()));

    // Accepted, and a poll is armed at Requirement 5.2's cadence without anyone asking.
    expect(orchestrator.pollingJobIds).toEqual([jobId]);
    expect(harness.scheduler.pendingDelaysMs).toEqual([5_000]);

    // First poll: running at 40 %. Still armed.
    await drainScheduler(harness.scheduler, 1);
    await flushAsync();
    expect((await orchestrator.statusOf(jobId, 'user-1')).progressPercent).toBe(40);
    expect(orchestrator.pollingJobIds).toEqual([jobId]);

    // Second poll: succeeded. Assets published, loop forgotten, nothing left to run.
    await drainScheduler(harness.scheduler, 1);
    await flushAsync();
    const view = await orchestrator.statusOf(jobId, 'user-1');
    expect(view.state).toBe('succeeded');
    expect(view.assetIds).toHaveLength(1);
    expect(harness.assets.published).toEqual([{ jobId, count: 1 }]);
    expect(orchestrator.pollingJobIds).toEqual([]);
    expect(harness.scheduler.pendingDelaysMs).toEqual([]);
    expect(harness.adapter.pollCount).toBe(2);
  });

  it('stops polling a job the user cancelled', async () => {
    const harness = createGenerationHarness();
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime);

    const jobId = accepted(await orchestrator.submit(submission()));
    await orchestrator.cancel(jobId, 'user-1');

    expect(orchestrator.pollingJobIds).toEqual([]);
    // The armed task was cancelled, so draining runs nothing and the engine is never asked.
    await drainScheduler(harness.scheduler, 4);
    expect(harness.adapter.pollCount).toBe(0);
  });

  it('arms a loop for the new job a retry creates', async () => {
    const harness = createGenerationHarness();
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime);
    // Every permitted submission attempt is refused, so the first job fails retryably.
    harness.adapter.failSubmit(new Error('engine busy'), 4);

    // The Requirement 6.2 backoff waits on the manual scheduler, so the submission settles
    // only while the scheduler is being drained beside it.
    const submitting = orchestrator.submit(submission());
    await drainScheduler(harness.scheduler, 8);
    const failed = await submitting;
    if (failed.kind !== 'failed') throw new Error(`expected a failed job, got ${failed.kind}`);
    expect(orchestrator.pollingJobIds).toEqual([]);

    const retried = accepted(await orchestrator.retry(failed.jobId, 'user-1'));
    expect(retried).not.toBe(failed.jobId);
    expect(orchestrator.pollingJobIds).toEqual([retried]);
  });

  it('reports a poll that threw and leaves the job to the sweep', async () => {
    const harness = createGenerationHarness();
    const errors: { jobId: string; error: unknown }[] = [];
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime, {
      onPollError: (jobId, error) => errors.push({ jobId, error }),
    });
    const jobId = accepted(await orchestrator.submit(submission()));

    // Take the store away underneath the job: the first thing a poll does is `store.find`, and
    // a store that throws is the failure a timer callback must not turn into an unhandled
    // rejection. (An engine that fails to answer is not this case — `callRemoteEngine` turns
    // that into Requirement 6.5's unreachable event, and the loop carries on.)
    Object.assign(harness.store, {
      find: async () => {
        throw new Error('store unavailable');
      },
    });
    await drainScheduler(harness.scheduler, 1);
    await flushAsync();

    expect(errors.map((entry) => entry.jobId)).toEqual([jobId]);
    expect(orchestrator.pollingJobIds).toEqual([]);
    expect(harness.scheduler.pendingDelaysMs).toEqual([]);
  });

  it('stopPolling cancels every live loop at shutdown', async () => {
    const harness = createGenerationHarness();
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime);
    accepted(await orchestrator.submit(submission()));
    accepted(await orchestrator.submit(submission()));
    expect(orchestrator.pollingJobIds).toHaveLength(2);

    orchestrator.stopPolling();

    expect(orchestrator.pollingJobIds).toEqual([]);
    await drainScheduler(harness.scheduler, 4);
    expect(harness.adapter.pollCount).toBe(0);
  });
});

describe('startTimeoutSweep', () => {
  it('runs the Requirement 5.8 sweep on the interval and re-arms after each run', async () => {
    const harness = createGenerationHarness();
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime);
    const jobId = accepted(await orchestrator.submit(submission()));
    // The poll loop is not the subject here; a sweep must end the job on its own.
    orchestrator.stopPolling();

    const sweep = startTimeoutSweep(orchestrator, harness.scheduler, 60_000);
    expect(harness.scheduler.pendingDelaysMs).toEqual([60_000]);

    // Not yet overdue: the sweep runs, fails nothing, and arms the next one.
    await drainScheduler(harness.scheduler, 1);
    await flushAsync();
    expect((await orchestrator.statusOf(jobId, 'user-1')).state).toBe('pending');
    expect(harness.scheduler.pendingDelaysMs).toEqual([60_000]);

    // Past the budget: the next sweep fails and refunds it.
    harness.clock.advanceSeconds(JOB_TIMEOUT_MS / 1000 + 1);
    await drainScheduler(harness.scheduler, 1);
    await flushAsync();
    const view = await orchestrator.statusOf(jobId, 'user-1');
    expect(view.state).toBe('failed');
    expect(view.failure?.reason).toBe('job_timeout');
    expect(harness.refunds.requests.map((request) => request.jobId)).toEqual([jobId]);

    sweep.cancel();
    expect(harness.scheduler.pendingDelaysMs).toEqual([]);
  });

  it('keeps sweeping after a sweep threw, and reports the error', async () => {
    const harness = createGenerationHarness();
    const orchestrator = new SelfPollingJobOrchestrator(harness.runtime);
    const errors: unknown[] = [];
    const failing = Object.create(orchestrator, {
      sweepTimeouts: { value: async () => Promise.reject(new Error('store unavailable')) },
    }) as SelfPollingJobOrchestrator;

    const sweep = startTimeoutSweep(failing, harness.scheduler, 60_000, (error) => errors.push(error));
    await drainScheduler(harness.scheduler, 1);
    await flushAsync();

    expect(errors).toHaveLength(1);
    expect(harness.scheduler.pendingDelaysMs).toEqual([60_000]);
    sweep.cancel();
  });
});
