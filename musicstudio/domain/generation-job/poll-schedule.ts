/**
 * Status-poll cadence (Requirements 5.2, 6.5; design §2.3).
 *
 * 5.2 caps the gap between polls of a pending or running job at 5 seconds. 6.5
 * covers the other case: the engine could not be reached, and polling must resume
 * within 60 seconds. A single fixed 5-second timer would satisfy both, but would
 * also hammer an engine that is down, so the unreachable path backs off — bounded
 * by the 60-second ceiling 6.5 sets, which is the point of the `Math.min`.
 *
 * Pure: produces delays for the injected `Scheduler` to apply.
 */

/** Requirement 5.2: the interval must be 5 seconds *or less*. */
export const POLL_INTERVAL_MS = 5_000;

/** Requirement 6.5: polling resumes no later than this after a failed contact. */
export const RESUME_POLL_MAX_DELAY_MS = 60_000;

/**
 * Delay before the next poll.
 *
 * `consecutiveUnreachable` is the number of contact failures since the last
 * successful poll; 0 means the previous poll succeeded and the plain 5-second
 * cadence applies.
 */
export function nextPollDelayMs(consecutiveUnreachable: number): number {
  if (!Number.isFinite(consecutiveUnreachable) || consecutiveUnreachable <= 0) {
    return POLL_INTERVAL_MS;
  }
  const backoff = POLL_INTERVAL_MS * 2 ** Math.floor(consecutiveUnreachable);
  return Math.min(backoff, RESUME_POLL_MAX_DELAY_MS);
}

/** Requirement 5.2 predicate for an observed gap between two polls. */
export function isWithinPollInterval(deltaMs: number): boolean {
  return deltaMs <= POLL_INTERVAL_MS;
}

/** Requirement 6.5 predicate for the resume delay after a connection failure. */
export function isWithinResumeBound(deltaMs: number): boolean {
  return deltaMs <= RESUME_POLL_MAX_DELAY_MS;
}
