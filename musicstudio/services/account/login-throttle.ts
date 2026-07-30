import { addSeconds, systemClock, type Clock } from './clock';
import { loginTemporarilyLocked } from './errors';

/** Requirement 1.5: the failure count at which login starts being refused. */
export const MAX_CONSECUTIVE_LOGIN_FAILURES = 5;

/** Requirement 1.5: how long login stays refused once the threshold is hit. */
export const LOGIN_LOCK_DURATION_SECONDS = 15 * 60;

export interface LoginAttemptState {
  readonly failures: number;
  readonly lockedUntil: Date | null;
}

/**
 * Failure-counter port. Redis backs it in production (design §2.4) so the
 * counter is shared across gateway instances; an in-memory implementation
 * backs it in tests.
 */
export interface LoginAttemptStore {
  read(key: string): Promise<LoginAttemptState | null>;
  write(key: string, state: LoginAttemptState, ttlSeconds: number): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface LoginThrottle {
  /** Throws `login_temporarily_locked` (429) while the account is locked. */
  assertNotLocked(key: string): Promise<void>;
  /** Requirement 1.4: increments the counter; locks at the 5th failure. */
  recordFailure(key: string): Promise<LoginAttemptState>;
  /** Clears the counter after a successful authentication. */
  reset(key: string): Promise<void>;
}

export interface LoginThrottleOptions {
  readonly store: LoginAttemptStore;
  readonly clock?: Clock;
  readonly maxFailures?: number;
  readonly lockDurationSeconds?: number;
}

/**
 * Consecutive-failure lockout for Requirements 1.4 and 1.5.
 *
 * The lock window is measured against the injected clock, never against a
 * timer, which is what makes "refused for 15 minutes, then allowed again"
 * assertable without sleeping in a test.
 */
export function createLoginThrottle(options: LoginThrottleOptions): LoginThrottle {
  const clock = options.clock ?? systemClock;
  const maxFailures = options.maxFailures ?? MAX_CONSECUTIVE_LOGIN_FAILURES;
  const lockDurationSeconds = options.lockDurationSeconds ?? LOGIN_LOCK_DURATION_SECONDS;
  const { store } = options;

  function remainingLockSeconds(state: LoginAttemptState | null, now: Date): number {
    const lockedUntil = state?.lockedUntil ?? null;
    if (lockedUntil === null) {
      return 0;
    }
    const remainingMs = lockedUntil.getTime() - now.getTime();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  return {
    async assertNotLocked(key): Promise<void> {
      const remaining = remainingLockSeconds(await store.read(key), clock.now());
      if (remaining > 0) {
        throw loginTemporarilyLocked(remaining);
      }
    },

    async recordFailure(key): Promise<LoginAttemptState> {
      const now = clock.now();
      const previous = await store.read(key);
      const lockStillActive = remainingLockSeconds(previous, now) > 0;

      // An elapsed lock starts a fresh streak: the previous streak has already
      // been paid for with the 15-minute refusal.
      const priorFailures = previous === null || (!lockStillActive && previous.lockedUntil !== null)
        ? 0
        : previous.failures;

      const failures = priorFailures + 1;
      const lockedUntil =
        failures >= maxFailures ? addSeconds(now, lockDurationSeconds) : null;
      const next: LoginAttemptState = { failures, lockedUntil };

      await store.write(key, next, lockDurationSeconds);
      return next;
    },

    async reset(key): Promise<void> {
      await store.clear(key);
    },
  };
}
