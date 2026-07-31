/**
 * Health-check cadence (Requirement 20.7: 60 seconds ± 5 seconds).
 *
 * The jitter is deliberate — a fixed 60-second period would make every engine
 * probe fire in the same tick — and it is drawn from an injected `random`
 * function so tests can pin the delay instead of observing a range.
 *
 * The scheduler itself is a port: production passes a `setTimeout`-backed
 * implementation, tests pass a manual one and drive the clock forward. Nothing
 * in this module sleeps.
 */

export const HEALTH_CHECK_INTERVAL_MS = 60_000;
export const HEALTH_CHECK_JITTER_MS = 5_000;
export const HEALTH_CHECK_MIN_INTERVAL_MS = HEALTH_CHECK_INTERVAL_MS - HEALTH_CHECK_JITTER_MS;
export const HEALTH_CHECK_MAX_INTERVAL_MS = HEALTH_CHECK_INTERVAL_MS + HEALTH_CHECK_JITTER_MS;

/** Returns a delay in [55000, 65000] ms. `random` must yield [0, 1). */
export function nextCheckDelayMs(random: () => number = Math.random): number {
  const offset = Math.round((random() * 2 - 1) * HEALTH_CHECK_JITTER_MS);
  const delay = HEALTH_CHECK_INTERVAL_MS + offset;
  return Math.min(HEALTH_CHECK_MAX_INTERVAL_MS, Math.max(HEALTH_CHECK_MIN_INTERVAL_MS, delay));
}

/** Requirement 20.7 tolerance predicate for an observed gap between checks. */
export function isWithinCheckTolerance(deltaMs: number): boolean {
  return deltaMs >= HEALTH_CHECK_MIN_INTERVAL_MS && deltaMs <= HEALTH_CHECK_MAX_INTERVAL_MS;
}

export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  after(delayMs: number, task: () => void): ScheduledTask;
}

export const realScheduler: Scheduler = {
  after(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};
