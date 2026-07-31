/**
 * The 900-second Generation_Job budget (Requirement 5.8).
 *
 * ## How this composes with the 300-second remote-call cap
 *
 * Two timeouts exist and they are deliberately *nested*, not parallel:
 *
 * - `REMOTE_CALL_TIMEOUT_MS` (300 s, Requirement 20.14, enforced by
 *   `adapters/timeout-runner.ts` via `adapters/registry/remote-call.ts`) bounds
 *   **one HTTP call** to an engine — a submit, a poll, a result fetch.
 * - `JOB_TIMEOUT_MS` (900 s, this module) bounds the **whole job**, from the
 *   instant it was accepted until it reaches a terminal state, across however many
 *   remote calls that takes.
 *
 * The inner bound is strictly smaller than the outer one, which is asserted rather
 * than assumed (`test/unit/generation/timeout-composition.test.ts`). That
 * inequality is what makes them one mechanism instead of two competing ones:
 *
 * 1. A hung engine call trips the inner cap first. `callRemoteEngine` already does
 *    the Requirement 20.15 work — records the timeout reason and drives the refund
 *    with a 60 s deadline — and hands back a `timed_out` outcome. The orchestrator
 *    turns that outcome into a single `engine_failed` lifecycle event, so the job
 *    becomes terminal through the same transition every other failure uses.
 * 2. The 900 s sweep therefore only ever fires for a job that is *still
 *    non-terminal* — one whose individual calls all returned in time but which
 *    never reached success or failure (an engine stuck at status 0, or repeated
 *    unreachability under Requirement 6.5).
 * 3. If both somehow fire, the second is absorbed: `applyJobLifecycleEvent`
 *    rejects every event against a terminal state with `already_terminal` and
 *    reports no effects, so the refund happens exactly once. The refund itself is
 *    driven through the one `CreditRefundPort` in both paths, never two ledgers.
 *
 * Pure: elapsed time is computed from instants the caller supplies, so tests never
 * sleep.
 */

/** Requirement 5.8. */
export const JOB_TIMEOUT_MS = 900_000;

export function jobDeadlineMs(acceptedAtMs: number): number {
  return acceptedAtMs + JOB_TIMEOUT_MS;
}

/**
 * Requirement 5.8 reads "not terminal *within* 900 seconds", so the boundary
 * instant is already too late: the comparison is inclusive.
 */
export function isJobTimedOut(acceptedAtMs: number, nowMs: number): boolean {
  return nowMs - acceptedAtMs >= JOB_TIMEOUT_MS;
}

/** Remaining budget, floored at zero. */
export function remainingJobBudgetMs(acceptedAtMs: number, nowMs: number): number {
  return Math.max(0, jobDeadlineMs(acceptedAtMs) - nowMs);
}
