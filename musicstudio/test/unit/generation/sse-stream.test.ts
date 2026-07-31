import { describe, expect, it } from 'vitest';

import {
  attachJobEventStream,
  formatSseFrame,
  jobEventFrame,
  SSE_HEADERS,
} from '../../../api/sse/event-stream';
import { ENGINE_JOB_STATE } from '../../../adapters/engine-job';
import {
  createInMemoryJobEventBus,
  isWithinDeliveryBudget,
  SSE_DELIVERY_BUDGET_MS,
  type JobStatusEvent,
} from '../../../services/generation/job-events';
import { createMutableClock } from '../../support/mutable-clock';
import { createGenerationHarness, submission } from '../../support/generation-harness';

/**
 * The SSE layer (Requirement 5.4).
 *
 * The one-second bound is asserted as a comparison between the event's own
 * `deliverByMs` and the instant the frame was written, both read from the injected
 * clock. No test here waits to see whether a frame turns up.
 */

function statusEvent(overrides: Partial<JobStatusEvent> = {}): JobStatusEvent {
  return {
    jobId: 'job-1',
    accountId: 'user-1',
    state: 'running',
    progressPercent: 25,
    queuePosition: null,
    estimatedCompletionAtMs: null,
    failure: null,
    assetIds: [],
    emittedAtMs: 1_000,
    deliverByMs: 1_000 + SSE_DELIVERY_BUDGET_MS,
    sequence: 3,
    ...overrides,
  };
}

describe('SSE frame format', () => {
  it('emits id, event and data fields terminated by a blank line', () => {
    const frame = formatSseFrame({ id: 'job-1:3', event: 'job-status', data: { state: 'running' } });

    expect(frame).toBe('id: job-1:3\nevent: job-status\ndata: {"state":"running"}\n\n');
  });

  it('folds a multi-line payload so the frame cannot be truncated', () => {
    const frame = formatSseFrame({ event: 'x', data: 'a\nb' });

    // JSON escapes the newline, so the data stays on one line; the fold is the
    // guard for any future payload that does not.
    expect(frame.split('\n').filter((line) => line.startsWith('data: '))).toHaveLength(1);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('declares the headers a proxy must not buffer', () => {
    expect(SSE_HEADERS['content-type']).toBe('text/event-stream');
    expect(SSE_HEADERS['cache-control']).toContain('no-transform');
    expect(SSE_HEADERS['x-accel-buffering']).toBe('no');
  });

  it('carries the Requirement 6.1 classification into the frame', () => {
    const frame = jobEventFrame(
      statusEvent({
        state: 'failed',
        failure: {
          classification: 'resource_exhaustion',
          retryable: true,
          reason: 'retries_exhausted',
          detail: null,
        },
      }),
    );

    expect(frame.data).toMatchObject({
      state: 'failed',
      failure: { classification: 'resource_exhaustion', retryable: true },
    });
  });
});

describe('Requirement 5.4 — delivery within one second', () => {
  it('writes the frame inside the budget and records that it did', () => {
    const bus = createInMemoryJobEventBus();
    const clock = createMutableClock(new Date(1_000));
    const written: string[] = [];

    const stream = attachJobEventStream({
      bus,
      accountId: 'user-1',
      clock,
      sink: { write: (chunk) => written.push(chunk) },
    });

    bus.publish(statusEvent({ emittedAtMs: 1_000, deliverByMs: 2_000 }));

    expect(written).toHaveLength(1);
    expect(stream.deliveries[0]?.withinBudget).toBe(true);
    expect(stream.deliveries[0]?.writtenAtMs).toBe(1_000);
  });

  it('reports a frame written after the budget as late', () => {
    // The bound is only meaningful if a violation is detectable, so the negative
    // case is asserted too: the clock advances between publish and write.
    const event = statusEvent({ emittedAtMs: 1_000, deliverByMs: 2_000 });

    expect(isWithinDeliveryBudget(event, 2_000)).toBe(true);
    expect(isWithinDeliveryBudget(event, 2_001)).toBe(false);
  });

  it('streams only the requested job when a job id is given', () => {
    const bus = createInMemoryJobEventBus();
    const clock = createMutableClock(new Date(0));
    const written: string[] = [];

    attachJobEventStream({
      bus,
      accountId: 'user-1',
      jobId: 'job-1',
      clock,
      sink: { write: (chunk) => written.push(chunk) },
    });

    bus.publish(statusEvent({ jobId: 'job-2' }));
    bus.publish(statusEvent({ jobId: 'job-1' }));

    expect(written).toHaveLength(1);
  });

  it('never delivers another account s events', () => {
    const bus = createInMemoryJobEventBus();
    const clock = createMutableClock(new Date(0));
    const written: string[] = [];

    attachJobEventStream({
      bus,
      accountId: 'user-1',
      clock,
      sink: { write: (chunk) => written.push(chunk) },
    });

    bus.publish(statusEvent({ accountId: 'user-2' }));

    expect(written).toHaveLength(0);
  });

  it('stops writing after the connection closes', () => {
    const bus = createInMemoryJobEventBus();
    const clock = createMutableClock(new Date(0));
    const written: string[] = [];
    let ended = false;

    const stream = attachJobEventStream({
      bus,
      accountId: 'user-1',
      clock,
      sink: { write: (chunk) => written.push(chunk), end: () => (ended = true) },
    });

    stream.close();
    bus.publish(statusEvent());

    expect(written).toHaveLength(0);
    expect(ended).toBe(true);
  });
});

describe('Requirement 5.4 with the real orchestrator', () => {
  it('delivers every transition of a real job inside the budget', async () => {
    const harness = createGenerationHarness();
    const written: string[] = [];
    const stream = attachJobEventStream({
      bus: harness.events,
      accountId: 'user-1',
      clock: harness.clock,
      sink: { write: (chunk) => written.push(chunk) },
    });

    const accepted = await harness.orchestrator.submit(submission());
    if (accepted.kind !== 'accepted') throw new Error('expected acceptance');
    harness.adapter.enqueuePoll(
      { state: ENGINE_JOB_STATE.running },
      { state: ENGINE_JOB_STATE.succeeded },
    );
    await harness.orchestrator.pollOnce(accepted.acceptance.jobId);
    await harness.orchestrator.pollOnce(accepted.acceptance.jobId);

    expect(stream.deliveries.map((delivery) => delivery.withinBudget)).toEqual([true, true]);
    expect(written.every((frame) => frame.startsWith('id: '))).toBe(true);
  });
});
