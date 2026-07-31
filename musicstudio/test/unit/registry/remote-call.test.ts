import { describe, expect, it } from 'vitest';

import {
  REFUND_DEADLINE_MS,
  callRemoteEngine,
} from '../../../adapters/registry/remote-call';
import { REMOTE_CALL_TIMEOUT_MS } from '../../../adapters/timeout-runner';
import { createMutableClock } from '../../support/mutable-clock';
import {
  createRecordingRefundPort,
  createScriptedTimeoutRunner,
} from '../../support/registry-harness';

/** Requirements 20.14 (300 s cap) and 20.15 (timeout -> failure + full refund). */
describe('remote engine call budget (Req 20.14, 20.15)', () => {
  const context = {
    engineId: 'ace-step-1.5',
    accountId: 'account-1',
    jobId: 'job-9',
    debitedAmount: 42,
  };

  function deps() {
    const clock = createMutableClock(new Date('2025-03-01T12:00:00.000Z'));
    const timeoutRunner = createScriptedTimeoutRunner();
    const refunds = createRecordingRefundPort();
    return { clock, timeoutRunner, refunds };
  }

  it('caps the call at 300 seconds (Req 20.14)', async () => {
    const { clock, timeoutRunner, refunds } = deps();

    await callRemoteEngine(async () => 'ok', context, { clock, timeoutRunner, refunds });

    expect(timeoutRunner.observedBudgetsMs).toEqual([REMOTE_CALL_TIMEOUT_MS]);
  });

  it('returns the value when the engine answers in time', async () => {
    const { clock, timeoutRunner, refunds } = deps();

    const outcome = await callRemoteEngine(async () => 'audio', context, {
      clock,
      timeoutRunner,
      refunds,
    });

    expect(outcome).toEqual({ kind: 'completed', value: 'audio' });
    expect(refunds.requests).toEqual([]);
  });

  it('records the engine id and timeout reason, and refunds the full amount (Req 20.15)', async () => {
    const { clock, timeoutRunner, refunds } = deps();
    timeoutRunner.timeOutNext();

    const outcome = await callRemoteEngine(
      () => new Promise<string>(() => undefined),
      context,
      { clock, timeoutRunner, refunds },
    );

    if (outcome.kind !== 'timed_out') throw new Error('expected a timeout');
    const failedAtMs = Date.parse('2025-03-01T12:00:00.000Z');

    expect(outcome.record).toEqual({
      engineId: 'ace-step-1.5',
      reason: 'engine_timeout',
      budgetMs: REMOTE_CALL_TIMEOUT_MS,
      failedAtMs,
      refundDeadlineMs: failedAtMs + REFUND_DEADLINE_MS,
      refundedAmount: 42,
    });

    // The whole debited amount, and a deadline 60 seconds after the failure.
    expect(refunds.requests).toEqual([
      {
        accountId: 'account-1',
        jobId: 'job-9',
        engineId: 'ace-step-1.5',
        reason: 'engine_timeout',
        amount: 42,
        refundDeadlineMs: failedAtMs + REFUND_DEADLINE_MS,
      },
    ]);
    expect(REFUND_DEADLINE_MS).toBe(60_000);
  });

  it('reports an engine error without refunding through the timeout path', async () => {
    const { clock, timeoutRunner, refunds } = deps();

    const outcome = await callRemoteEngine(
      () => Promise.reject(new Error('engine returned 503')),
      context,
      { clock, timeoutRunner, refunds },
    );

    expect(outcome).toEqual({
      kind: 'failed',
      engineId: 'ace-step-1.5',
      reason: 'engine returned 503',
    });
    expect(refunds.requests).toEqual([]);
  });
});
