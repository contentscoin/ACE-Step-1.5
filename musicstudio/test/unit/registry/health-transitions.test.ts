import { describe, expect, it } from 'vitest';

import type { HealthCheckOutcome } from '../../../adapters/registry/health-history';
import {
  CONSECUTIVE_FAILURES_TO_UNAVAILABLE,
  CONSECUTIVE_SUCCESSES_TO_AVAILABLE,
  applyHealthOutcome,
  foldHealthOutcomes,
  initialAvailabilityState,
} from '../../../adapters/registry/health-transitions';

/**
 * The availability state machine on its own: Requirement 20.8 (three consecutive
 * failures -> unavailable) and 20.21 (two consecutive successes while unavailable
 * -> available). `health-monitor.test.ts` covers the same two criteria through a
 * registry and an adapter; here the rule is stated over whole outcome sequences.
 */

const F: HealthCheckOutcome = 'failure';
const S: HealthCheckOutcome = 'success';

describe('availability state machine (Req 20.8, 20.21)', () => {
  it('starts available with both streaks at zero', () => {
    expect(initialAvailabilityState).toEqual({
      availability: 'available',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    });
    expect(CONSECUTIVE_FAILURES_TO_UNAVAILABLE).toBe(3);
    expect(CONSECUTIVE_SUCCESSES_TO_AVAILABLE).toBe(2);
  });

  it.each([
    [[F], 'available'],
    [[F, F], 'available'],
    [[F, F, F], 'unavailable'],
    [[F, F, S, F, F], 'available'],
    [[F, F, S, F, F, F], 'unavailable'],
    [[S, S, S, S], 'available'],
  ] as const)('folds %j to %s', (outcomes, expected) => {
    expect(foldHealthOutcomes([...outcomes]).availability).toBe(expected);
  });

  it('never goes unavailable on a prefix with fewer than three trailing failures', () => {
    // Every prefix of an alternating sequence has at most one trailing failure.
    const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? F : S));
    for (let length = 0; length <= alternating.length; length += 1) {
      expect(foldHealthOutcomes(alternating.slice(0, length)).availability).toBe('available');
    }
  });

  it('needs two fresh successes after each outage rather than inheriting a streak', () => {
    // One success before the outage must not count towards the recovery.
    const afterOneSuccess = foldHealthOutcomes([S, F, F, F, S]);
    expect(afterOneSuccess.availability).toBe('unavailable');
    expect(afterOneSuccess.consecutiveSuccesses).toBe(1);

    const recovered = applyHealthOutcome(afterOneSuccess, S);
    expect(recovered.transition).toBe('became_available');
    expect(recovered.state.availability).toBe('available');
    // The streak restarts, so the next outage needs its own two successes.
    expect(recovered.state.consecutiveSuccesses).toBe(0);
  });

  it('reports a transition exactly on the step where availability changes', () => {
    const outcomes: HealthCheckOutcome[] = [F, F, F, F, S, S, S];
    const transitions: (string | null)[] = [];
    let state = initialAvailabilityState;

    for (const outcome of outcomes) {
      const step = applyHealthOutcome(state, outcome);
      transitions.push(step.transition);
      state = step.state;
    }

    expect(transitions).toEqual([
      null,
      null,
      'became_unavailable',
      null,
      null,
      'became_available',
      null,
    ]);
  });

  it('keeps counting failures while already unavailable without re-firing the event', () => {
    const state = foldHealthOutcomes([F, F, F, F, F]);

    expect(state.availability).toBe('unavailable');
    expect(state.consecutiveFailures).toBe(5);
    expect(applyHealthOutcome(state, F).transition).toBeNull();
  });
});
