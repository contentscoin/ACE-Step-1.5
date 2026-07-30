import type { Clock } from '../../services/account/clock';

export interface MutableClock extends Clock {
  /** Moves the clock forward. Requirement 1.5/1.8 tests use this, never sleep. */
  advanceSeconds(seconds: number): void;
  set(instant: Date): void;
}

export function createMutableClock(start: Date = new Date('2025-01-01T00:00:00.000Z')): MutableClock {
  let current = start;

  return {
    now: () => current,
    advanceSeconds: (seconds) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
    set: (instant) => {
      current = instant;
    },
  };
}
