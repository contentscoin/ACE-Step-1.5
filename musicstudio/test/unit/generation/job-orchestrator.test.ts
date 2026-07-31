import { describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../../adapters/engine-job';
import { isRegistryError } from '../../../adapters/registry/errors';
import { JOB_TIMEOUT_MS } from '../../../domain/generation-job/timeout';
import { isGenerationError } from '../../../services/generation/errors';
import {
  createGenerationHarness,
  drainScheduler,
  submission,
  type GenerationHarness,
} from '../../support/generation-harness';

/**
 * The Job_Orchestrator end to end, with every collaborator faked (Requirements
 * 5.1–5.8, 6.1–6.6).
 *
 * Nothing here waits. Delays land on the manual scheduler and are run explicitly;
 * the 900-second budget is crossed by moving the injected clock.
 */

async function acceptedJob(harness: GenerationHarness): Promise<string> {
  const outcome = await harness.orchestrator.submit(submission());
  if (outcome.kind !== 'accepted') {
    throw new Error(`expected acceptance, got ${outcome.kind}`);
  }
  return outcome.acceptance.jobId;
}

describe('Requirement 5.1 — accepting a job', () => {
  it('stores the engine job identifier and returns the id with a queue position', async () => {
    const harness = createGenerationHarness();

    const outcome = await harness.orchestrator.submit(submission());

    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.acceptance.queuePosition).toBe(1);
    expect(outcome.acceptance.engineJobId).toBe(`${harness.adapter.engineId}-job-1`);
    expect(outcome.acceptance.state).toBe('pending');

    const stored = await harness.store.find(outcome.acceptance.jobId);
    expect(stored?.engineJobId).toBe(outcome.acceptance.engineJobId);
  });

  it('hands out increasing queue positions', async () => {
    const harness = createGenerationHarness();

    const first = await harness.orchestrator.submit(submission());
    const second = await harness.orchestrator.submit(submission());

    expect(first.kind === 'accepted' && first.acceptance.queuePosition).toBe(1);
    expect(second.kind === 'accepted' && second.acceptance.queuePosition).toBe(2);
  });

  it('Requirement 5.5 — offers an expected completion time while pending', async () => {
    const harness = createGenerationHarness({ averageDurationMs: 30_000 });
    const nowMs = harness.clock.now().getTime();

    const outcome = await harness.orchestrator.submit(submission());

    // Position 1, 30 s average: finishes one average duration from now.
    expect(outcome.kind === 'accepted' && outcome.acceptance.estimatedCompletionAtMs).toBe(
      nowMs + 30_000,
    );
  });

  it('Requirement 5.5 — offers no estimate when the engine reports no average', async () => {
    const harness = createGenerationHarness({ averageDurationMs: null });

    const outcome = await harness.orchestrator.submit(submission());

    expect(outcome.kind === 'accepted' && outcome.acceptance.estimatedCompletionAtMs).toBeNull();
  });
});

describe('Requirements 16.2 / 16.11 — moderation precedes any charge', () => {
  it('charges nothing when the request is blocked', async () => {
    const harness = createGenerationHarness();

    const outcome = await harness.orchestrator.submit(
      submission({
        moderate: () => ({
          outcome: 'blocked' as const,
          blocks: [{ code: 'policy_violation' as const, violations: [] }],
          violationClasses: [],
          texts: [],
        }),
      }),
    );

    expect(outcome.kind).toBe('blocked');
    expect(harness.charges.requests).toHaveLength(0);
    expect(harness.adapter.submitCount).toBe(0);
  });
});

describe('Requirement 6.6 — no healthy engine means a maintenance notice', () => {
  it('refuses the job with the registry rejection and charges nothing', async () => {
    const harness = createGenerationHarness({ withoutEngine: true });

    await expect(harness.orchestrator.submit(submission())).rejects.toSatisfy(
      (error: unknown) => isRegistryError(error) && error.code === 'no_available_engine',
    );
    expect(harness.charges.requests).toHaveLength(0);
  });
});

describe('Requirements 5.2, 5.3, 5.6 — progress and completion', () => {
  it('moves a job to running on a status 0 poll and notifies once', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.running, progressPercent: 40 });

    await harness.orchestrator.pollOnce(jobId);
    await harness.orchestrator.pollOnce(jobId);

    const stored = await harness.store.find(jobId);
    expect(stored?.lifecycle.state).toBe('running');
    expect(stored?.progressPercent).toBe(40);
    // The second poll observed no change, so it published nothing.
    expect(harness.received.filter((event) => event.state === 'running')).toHaveLength(1);
  });

  it('Requirement 5.6 — creates one asset per result audio on success', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.setResults([
      { audioBuffer: Buffer.from('a'), sampleRate: 44_100, durationMs: 1_000, seed: 1 },
      { audioBuffer: Buffer.from('b'), sampleRate: 44_100, durationMs: 1_000, seed: 2 },
      { audioBuffer: Buffer.from('c'), sampleRate: 44_100, durationMs: 1_000, seed: 3 },
    ]);
    harness.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.succeeded });

    await harness.orchestrator.pollOnce(jobId);

    expect(harness.assets.published).toEqual([{ jobId, count: 3 }]);
    const stored = await harness.store.find(jobId);
    expect(stored?.lifecycle.state).toBe('succeeded');
    expect(stored?.assetIds).toHaveLength(3);
    // A success never refunds.
    expect(harness.refunds.requests).toHaveLength(0);
  });

  it('Requirement 6.1 — a status 2 poll fails the job with a classification', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.setDefaultPoll({
      state: ENGINE_JOB_STATE.failed,
      failureReason: 'lyrics field invalid',
    });

    await harness.orchestrator.pollOnce(jobId);

    const stored = await harness.store.find(jobId);
    expect(stored?.lifecycle.state).toBe('failed');
    expect(stored?.lifecycle.failure?.classification).toBe('input_error');
    expect(stored?.lifecycle.failure?.retryable).toBe(false);
    expect(harness.refunds.requests).toHaveLength(1);
    expect(harness.auditFor(jobId)).toHaveLength(1);
  });

  it('Requirement 6.5 — an unreachable engine keeps the job pending', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.failPoll(new Error('ECONNREFUSED'), 2);

    await harness.orchestrator.pollOnce(jobId);
    await harness.orchestrator.pollOnce(jobId);

    const stored = await harness.store.find(jobId);
    expect(stored?.lifecycle.state).toBe('pending');
    expect(stored?.unreachableStreak).toBe(2);
    expect(harness.refunds.requests).toHaveLength(0);

    // And a later successful poll clears the streak.
    harness.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.running });
    await harness.orchestrator.pollOnce(jobId);
    expect((await harness.store.find(jobId))?.unreachableStreak).toBe(0);
  });
});

describe('Requirement 5.7 — cancellation', () => {
  it('cancels a pending job, refunds it and tells the engine', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);

    const view = await harness.orchestrator.cancel(jobId, 'user-1');

    expect(view.state).toBe('cancelled');
    expect(harness.refunds.requests).toEqual([
      expect.objectContaining({ jobId, amount: 12, accountId: 'user-1' }),
    ]);
    expect(harness.adapter.cancelled).toHaveLength(1);
    expect(await harness.queue.positionOf(jobId)).toBeNull();
  });

  it('refuses to cancel a job the engine already started', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.running });
    await harness.orchestrator.pollOnce(jobId);

    await expect(harness.orchestrator.cancel(jobId, 'user-1')).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.code === 'generation_job_not_cancellable',
    );
    expect(harness.refunds.requests).toHaveLength(0);
  });

  it('refuses a job belonging to another account', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);

    await expect(harness.orchestrator.cancel(jobId, 'someone-else')).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.statusCode === 403,
    );
  });

  it('refunds exactly once even if cancel is requested twice', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);

    await harness.orchestrator.cancel(jobId, 'user-1');
    await expect(harness.orchestrator.cancel(jobId, 'user-1')).rejects.toBeDefined();

    expect(harness.refunds.requests).toHaveLength(1);
  });
});

describe('Requirement 5.8 — the 900 second budget', () => {
  it('fails and refunds a job that never reached a terminal state', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);

    harness.clock.advanceSeconds(JOB_TIMEOUT_MS / 1_000);
    const swept = await harness.orchestrator.sweepTimeouts();

    expect(swept.timedOutJobIds).toEqual([jobId]);
    const stored = await harness.store.find(jobId);
    expect(stored?.lifecycle.state).toBe('failed');
    expect(stored?.lifecycle.failure?.reason).toBe('job_timeout');
    expect(harness.refunds.requests).toHaveLength(1);
    expect(harness.auditFor(jobId)).toHaveLength(1);
  });

  it('leaves a job inside its budget alone', async () => {
    const harness = createGenerationHarness();
    await acceptedJob(harness);

    harness.clock.advanceSeconds(899);

    expect((await harness.orchestrator.sweepTimeouts()).timedOutJobIds).toEqual([]);
  });

  it('fails an overdue job on its next poll, before contacting the engine', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    const pollsBefore = harness.adapter.pollCount;

    harness.clock.advanceSeconds(901);
    await harness.orchestrator.pollOnce(jobId);

    expect(harness.adapter.pollCount).toBe(pollsBefore);
    expect((await harness.store.find(jobId))?.lifecycle.failure?.reason).toBe('job_timeout');
  });

  it('refunds once when the sweep and a poll both see the same overdue job', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);

    harness.clock.advanceSeconds(901);
    await harness.orchestrator.sweepTimeouts();
    await harness.orchestrator.pollOnce(jobId);
    await harness.orchestrator.sweepTimeouts();

    expect(harness.refunds.requests).toHaveLength(1);
  });
});

describe('Requirement 20.15 composition — a hung engine call', () => {
  it('fails the job through the lifecycle and refunds exactly once', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    // The 300 s cap trips on the poll; `callRemoteEngine` performs the refund.
    harness.timeoutRunner.timeOutNext();

    await harness.orchestrator.pollOnce(jobId);

    const stored = await harness.store.find(jobId);
    expect(stored?.lifecycle.state).toBe('failed');
    expect(stored?.lifecycle.failure?.reason).toBe('engine_timeout');
    // One refund, from the Requirement 20.15 path, not two.
    expect(harness.refunds.requests).toHaveLength(1);
    expect(harness.refunds.requests[0]?.reason).toBe('engine_timeout');
  });
});

describe('Requirements 6.2, 6.3 — engine queue saturation', () => {
  it('re-requests up to three times with the 2/4/8 second backoff', async () => {
    const harness = createGenerationHarness();
    const saturated = Object.assign(new Error('queue full'), { statusCode: 429 });
    harness.adapter.failSubmit(saturated, 2);

    const submitting = harness.orchestrator.submit(submission());
    await drainScheduler(harness.scheduler);
    const outcome = await submitting;

    expect(outcome.kind).toBe('accepted');
    expect(harness.adapter.submitCount).toBe(3);
    expect(harness.scheduler.pendingDelaysMs).toEqual([]);
  });

  it('confirms failure, refunds and audits when all three re-requests fail', async () => {
    const harness = createGenerationHarness();
    const saturated = Object.assign(new Error('queue full'), { statusCode: 429 });
    harness.adapter.failSubmit(saturated, 10);

    const submitting = harness.orchestrator.submit(submission());
    await drainScheduler(harness.scheduler);
    const outcome = await submitting;

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    // One original attempt plus three re-requests.
    expect(harness.adapter.submitCount).toBe(4);
    expect(outcome.failure.reason).toBe('retries_exhausted');
    expect(outcome.failure.classification).toBe('resource_exhaustion');
    expect(harness.refunds.requests).toHaveLength(1);
    expect(harness.auditFor(outcome.jobId)).toHaveLength(1);
  });

  it('does not re-request an input error', async () => {
    const harness = createGenerationHarness();
    harness.adapter.failSubmit(Object.assign(new Error('bad prompt'), { statusCode: 400 }), 10);

    const outcome = await harness.orchestrator.submit(submission());

    expect(outcome.kind).toBe('failed');
    expect(harness.adapter.submitCount).toBe(1);
    expect(harness.scheduler.pendingDelaysMs).toEqual([]);
  });
});

describe('Requirement 6.4 — user-requested retry', () => {
  it('creates a new job with identical input parameters', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.setDefaultPoll({
      state: ENGINE_JOB_STATE.failed,
      failureReason: 'engine overload',
    });
    await harness.orchestrator.pollOnce(jobId);

    const retried = await harness.orchestrator.retry(jobId, 'user-1');

    expect(retried.kind).toBe('accepted');
    if (retried.kind !== 'accepted') return;
    const original = await harness.store.find(jobId);
    const replacement = await harness.store.find(retried.acceptance.jobId);

    expect(replacement?.input).toEqual(original?.input);
    expect(replacement?.retryOfJobId).toBe(jobId);
    expect(replacement?.jobId).not.toBe(jobId);
    expect(replacement?.lifecycle.state).toBe('pending');
  });

  it('refuses to retry a job that did not fail', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);

    await expect(harness.orchestrator.retry(jobId, 'user-1')).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.code === 'generation_job_not_retryable',
    );
  });

  it('refuses to retry a job whose failure was an input error', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.setDefaultPoll({
      state: ENGINE_JOB_STATE.failed,
      failureReason: 'caption invalid',
    });
    await harness.orchestrator.pollOnce(jobId);

    await expect(harness.orchestrator.retry(jobId, 'user-1')).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.code === 'generation_job_not_retryable',
    );
  });
});

describe('Requirement 5.4 — every state change is published', () => {
  it('publishes running, then succeeded, in sequence order', async () => {
    const harness = createGenerationHarness();
    const jobId = await acceptedJob(harness);
    harness.adapter.enqueuePoll(
      { state: ENGINE_JOB_STATE.running },
      { state: ENGINE_JOB_STATE.succeeded },
    );

    await harness.orchestrator.pollOnce(jobId);
    await harness.orchestrator.pollOnce(jobId);

    expect(harness.received.map((event) => event.state)).toEqual(['running', 'succeeded']);
    expect(harness.received.map((event) => event.sequence)).toEqual([1, 2]);
    for (const event of harness.received) {
      expect(event.deliverByMs).toBe(event.emittedAtMs + 1_000);
    }
  });
});
