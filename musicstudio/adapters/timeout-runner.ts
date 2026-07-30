/**
 * Time-budget port for engine calls (Requirements 20.7, 20.14).
 *
 * Two budgets exist in the spec — 10 seconds per health check (20.7) and 300
 * seconds per remote generation call (20.14) — and both are enforced here
 * rather than inside each adapter, so no adapter can silently exceed them.
 *
 * A port rather than a bare `setTimeout` race, because timing behaviour must be
 * assertable without a test ever waiting 10 or 300 real seconds.
 */

export const HEALTH_CHECK_TIMEOUT_MS = 10_000;
export const REMOTE_CALL_TIMEOUT_MS = 300_000;

export type TimeoutOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timed_out'; readonly budgetMs: number };

export interface TimeoutRunner {
  /** Runs `operation`, resolving to `timed_out` once `budgetMs` elapses. */
  run<T>(operation: () => Promise<T>, budgetMs: number): Promise<TimeoutOutcome<T>>;
}

/**
 * Production runner: races the operation against a real timer.
 *
 * The loser of the race is not cancelled — an engine HTTP client is expected to
 * carry its own abort signal — but its result is discarded, and the rejection is
 * swallowed so a late failure cannot surface as an unhandled rejection.
 */
export const realTimeoutRunner: TimeoutRunner = {
  run<T>(operation: () => Promise<T>, budgetMs: number): Promise<TimeoutOutcome<T>> {
    return new Promise<TimeoutOutcome<T>>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timed_out', budgetMs }), budgetMs);
      timer.unref?.();

      operation().then(
        (value) => {
          clearTimeout(timer);
          resolve({ kind: 'completed', value });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ kind: 'failed', error });
        },
      );
    });
  },
};
