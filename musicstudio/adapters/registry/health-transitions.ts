/**
 * Availability state machine (Requirements 20.8, 20.21).
 *
 * 20.8:  three consecutive failures     -> unavailable
 * 20.21: while unavailable, two consecutive successes -> available
 *
 * Pure, so the transition rule can be property-tested over arbitrary outcome
 * sequences without a registry, a clock or an engine.
 */

import type { HealthCheckOutcome } from './health-history';

export const CONSECUTIVE_FAILURES_TO_UNAVAILABLE = 3;
export const CONSECUTIVE_SUCCESSES_TO_AVAILABLE = 2;

export type EngineAvailability = 'available' | 'unavailable';

export interface AvailabilityState {
  readonly availability: EngineAvailability;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
}

export type AvailabilityTransition = 'became_unavailable' | 'became_available' | null;

export interface AvailabilityStep {
  readonly state: AvailabilityState;
  /** Non-null exactly when `availability` changed, which is what 20.20 audits. */
  readonly transition: AvailabilityTransition;
}

export const initialAvailabilityState: AvailabilityState = {
  availability: 'available',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
};

export function applyHealthOutcome(
  state: AvailabilityState,
  outcome: HealthCheckOutcome,
): AvailabilityStep {
  if (outcome === 'failure') {
    const consecutiveFailures = state.consecutiveFailures + 1;
    const becameUnavailable =
      state.availability === 'available' &&
      consecutiveFailures >= CONSECUTIVE_FAILURES_TO_UNAVAILABLE;

    return {
      state: {
        availability: becameUnavailable ? 'unavailable' : state.availability,
        consecutiveFailures,
        consecutiveSuccesses: 0,
      },
      transition: becameUnavailable ? 'became_unavailable' : null,
    };
  }

  const consecutiveSuccesses = state.consecutiveSuccesses + 1;
  const becameAvailable =
    state.availability === 'unavailable' &&
    consecutiveSuccesses >= CONSECUTIVE_SUCCESSES_TO_AVAILABLE;

  return {
    state: {
      availability: becameAvailable ? 'available' : state.availability,
      consecutiveFailures: 0,
      // Counting restarts on recovery so the next outage needs its own two
      // successes rather than inheriting a stale streak.
      consecutiveSuccesses: becameAvailable ? 0 : consecutiveSuccesses,
    },
    transition: becameAvailable ? 'became_available' : null,
  };
}

/**
 * Folds a whole outcome sequence, so a test can state a rule over a sequence
 * ("no prefix shorter than three failures goes unavailable") instead of over one
 * step at a time.
 */
export function foldHealthOutcomes(
  outcomes: readonly HealthCheckOutcome[],
  start: AvailabilityState = initialAvailabilityState,
): AvailabilityState {
  return outcomes.reduce<AvailabilityState>(
    (state, outcome) => applyHealthOutcome(state, outcome).state,
    start,
  );
}
