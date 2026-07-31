/**
 * Engine re-request policy (Requirements 6.2, 6.3).
 *
 * 6.2 fixes three numbers: exponential backoff, at most 3 re-requests, and at
 * least 2 seconds between attempts. Stating them as a schedule rather than as a
 * loop body means the whole sequence is checkable in one assertion, and the same
 * numbers configure the BullMQ job options (`services/generation/bullmq-queue.ts`)
 * without being written twice.
 *
 * Pure: returns delays, never waits for them.
 */

import { isRetryableFailureClass, type JobFailure } from './failure';

/** Requirement 6.2: at most three re-requests after the first attempt. */
export const MAX_ENGINE_RETRY_ATTEMPTS = 3;

/** Requirement 6.2: no two attempts closer together than this. */
export const MIN_RETRY_DELAY_MS = 2_000;

export const RETRY_BACKOFF_FACTOR = 2;

/**
 * Delay before re-request number `attempt` (1-based).
 *
 * `MIN_RETRY_DELAY_MS * FACTOR^(attempt-1)`, so the first re-request waits exactly
 * the 2-second floor and every later one waits longer. Attempts outside the
 * permitted range clamp to the floor rather than returning 0, because a caller
 * bug must not become a hot retry loop against a saturated engine.
 */
export function retryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return MIN_RETRY_DELAY_MS;
  const capped = Math.min(Math.floor(attempt), MAX_ENGINE_RETRY_ATTEMPTS);
  return MIN_RETRY_DELAY_MS * RETRY_BACKOFF_FACTOR ** (capped - 1);
}

/** The whole Requirement 6.2 schedule: `[2000, 4000, 8000]`. */
export function retryScheduleMs(): readonly number[] {
  return Array.from({ length: MAX_ENGINE_RETRY_ATTEMPTS }, (_unused, index) =>
    retryDelayMs(index + 1),
  );
}

/**
 * Whether another re-request is permitted.
 *
 * `attemptsMade` counts re-requests already spent, not the original attempt.
 * Retryability of the class is consulted as well as the count, so a 400-class
 * input error is not re-sent three times to be rejected three times — Requirement
 * 6.2's backoff exists for queue saturation, not for bad input.
 */
export function shouldRetryEngineRejection(attemptsMade: number, failure: JobFailure): boolean {
  if (!isRetryableFailureClass(failure.classification)) return false;
  return attemptsMade < MAX_ENGINE_RETRY_ATTEMPTS;
}

/** Requirement 6.2 predicate for an observed gap between two attempts. */
export function respectsMinimumRetryGap(deltaMs: number): boolean {
  return deltaMs >= MIN_RETRY_DELAY_MS;
}
