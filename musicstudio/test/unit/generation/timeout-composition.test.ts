import { describe, expect, it } from 'vitest';

import { REMOTE_CALL_TIMEOUT_MS } from '../../../adapters/timeout-runner';
import { REFUND_DEADLINE_MS } from '../../../adapters/registry/remote-call';
import {
  isJobTimedOut,
  jobDeadlineMs,
  JOB_TIMEOUT_MS,
  remainingJobBudgetMs,
} from '../../../domain/generation-job/timeout';
import {
  MAX_ENGINE_RETRY_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
  respectsMinimumRetryGap,
  retryDelayMs,
  retryScheduleMs,
  shouldRetryEngineRejection,
} from '../../../domain/generation-job/retry-policy';
import { classifyEngineFailure, jobFailure } from '../../../domain/generation-job/failure';

/**
 * The two time budgets, and how they compose (Requirements 5.8, 6.2, 20.14, 20.15).
 *
 * The point of this suite is that the 900-second job budget and the 300-second
 * remote-call cap are one nested mechanism rather than two competing ones. The
 * nesting is an inequality between two constants, so it is asserted here instead of
 * being left as a comment that could quietly stop being true.
 */

describe('Requirement 5.8 — the 900 second job budget', () => {
  it('is 900 seconds', () => {
    expect(JOB_TIMEOUT_MS).toBe(900_000);
  });

  it('treats the boundary instant as already too late', () => {
    // "within 900 seconds" excludes the 900-second mark itself.
    expect(isJobTimedOut(0, JOB_TIMEOUT_MS - 1)).toBe(false);
    expect(isJobTimedOut(0, JOB_TIMEOUT_MS)).toBe(true);
  });

  it('reports the deadline and the remaining budget from the accepted instant', () => {
    expect(jobDeadlineMs(1_000)).toBe(1_000 + JOB_TIMEOUT_MS);
    expect(remainingJobBudgetMs(1_000, 1_000)).toBe(JOB_TIMEOUT_MS);
    expect(remainingJobBudgetMs(1_000, 1_000 + JOB_TIMEOUT_MS + 5_000)).toBe(0);
  });
});

describe('composition with the Requirement 20.14 remote-call cap', () => {
  it('nests the per-call cap strictly inside the whole-job budget', () => {
    // The inner bound must trip first, otherwise a single hung call could consume
    // the entire job budget and the two mechanisms would race.
    expect(REMOTE_CALL_TIMEOUT_MS).toBeLessThan(JOB_TIMEOUT_MS);
  });

  it('leaves room for the submit, at least one retry and a poll inside one budget', () => {
    // Why a timed-out attempt is not retried (see `engine-submission.ts`): two
    // 300 s attempts plus the 2 s backoff already exceed two thirds of the budget,
    // and a third would exceed it outright.
    const twoAttempts = REMOTE_CALL_TIMEOUT_MS * 2 + MIN_RETRY_DELAY_MS;
    const threeAttempts = REMOTE_CALL_TIMEOUT_MS * 3;

    expect(twoAttempts).toBeLessThan(JOB_TIMEOUT_MS);
    expect(threeAttempts).toBeGreaterThanOrEqual(JOB_TIMEOUT_MS);
  });

  it('refunds inside the same 60 second deadline on either path', () => {
    // Both timeouts drive the one `CreditRefundPort` with this same bound, which is
    // what stops them being two refund mechanisms.
    expect(REFUND_DEADLINE_MS).toBe(60_000);
  });
});

describe('Requirement 6.2 — exponential backoff, three retries, two seconds apart', () => {
  it('permits exactly three re-requests', () => {
    expect(MAX_ENGINE_RETRY_ATTEMPTS).toBe(3);
  });

  it('doubles the delay from a two second floor', () => {
    expect(retryScheduleMs()).toEqual([2_000, 4_000, 8_000]);
  });

  it('keeps every gap at two seconds or more', () => {
    for (const delay of retryScheduleMs()) {
      expect(respectsMinimumRetryGap(delay)).toBe(true);
    }
  });

  it('clamps a nonsensical attempt number to the floor rather than to zero', () => {
    expect(retryDelayMs(0)).toBe(MIN_RETRY_DELAY_MS);
    expect(retryDelayMs(-3)).toBe(MIN_RETRY_DELAY_MS);
    expect(retryDelayMs(99)).toBe(retryDelayMs(MAX_ENGINE_RETRY_ATTEMPTS));
  });

  it('stops after the third re-request', () => {
    const saturated = classifyEngineFailure({ httpStatus: 429 });

    expect(shouldRetryEngineRejection(0, saturated)).toBe(true);
    expect(shouldRetryEngineRejection(2, saturated)).toBe(true);
    expect(shouldRetryEngineRejection(3, saturated)).toBe(false);
  });

  it('does not retry an input error at all', () => {
    expect(shouldRetryEngineRejection(0, jobFailure('input_error', 'engine_reported_failure'))).toBe(
      false,
    );
  });
});
