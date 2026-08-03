import { describe, expect, it } from 'vitest';

import {
  MOTION_PRESETS,
  MOTION_PRESET_IDS,
  SETTLE_TIME_MAX_MS,
  SETTLE_TOLERANCE,
  isMotionPresetId,
  settleTimeMs,
  settlesWithinBound,
  type SpringTransition,
} from '../../src/motion/presets';

/**
 * The five presets and the settle-time invariant.
 *
 * **Validates: Requirements 31.4, 31.19**
 *
 * 31.19 caps the settle time at 600 ms for **every** transition, which is an invariant over the
 * preset table rather than a property of any one component. The closed form in `settleTimeMs` is
 * checked against a *simulation* below before it is trusted — an analytic bound nobody validated is
 * a number that agrees with itself, and the whole point of the criterion is that a spring can ring
 * far longer than it looks like it will.
 */

describe('the preset table (Requirement 31.4)', () => {
  it('declares exactly the five presets design §8.2 names', () => {
    expect([...MOTION_PRESET_IDS]).toEqual(['snappy', 'bouncy', 'smooth', 'gentle', 'stiff']);
    expect(Object.keys(MOTION_PRESETS).sort()).toEqual([...MOTION_PRESET_IDS].sort());
  });

  it('recognises its own identifiers and nothing else', () => {
    for (const id of MOTION_PRESET_IDS) expect(isMotionPresetId(id)).toBe(true);
    for (const other of ['springy', '', 'SNAPPY', 42, null]) {
      expect(isMotionPresetId(other)).toBe(false);
    }
  });

  it('gives every preset a complete spring', () => {
    for (const id of MOTION_PRESET_IDS) {
      const spring = MOTION_PRESETS[id];
      expect(spring.type).toBe('spring');
      expect(spring.stiffness).toBeGreaterThan(0);
      expect(spring.damping).toBeGreaterThan(0);
      expect(spring.mass).toBeGreaterThan(0);
    }
  });
});

describe('settle time (Requirement 31.19)', () => {
  it('keeps every preset inside 600 ms', () => {
    for (const id of MOTION_PRESET_IDS) {
      const settle = settleTimeMs(MOTION_PRESETS[id]);
      expect(settle, `${id} settles in ${settle.toFixed(0)}ms`).toBeLessThanOrEqual(
        SETTLE_TIME_MAX_MS,
      );
      expect(settlesWithinBound(MOTION_PRESETS[id])).toBe(true);
    }
  });

  it('is an upper bound on a simulated spring, for every preset', () => {
    // The check that makes the analytic form trustworthy: integrate the spring and find the last
    // moment it is outside the tolerance band. The closed form must not be *under* that.
    for (const id of MOTION_PRESET_IDS) {
      const simulated = simulateSettleMs(MOTION_PRESETS[id]);
      const analytic = settleTimeMs(MOTION_PRESETS[id]);

      expect(analytic, `${id}: analytic ${analytic.toFixed(0)} < simulated ${simulated.toFixed(0)}`)
        .toBeGreaterThanOrEqual(simulated);
    }
  });

  it('refuses a spring that rings past the bound', () => {
    // The spring the module header warns about: plausible-looking, and well over a second.
    const ringing: SpringTransition = { type: 'spring', stiffness: 120, damping: 8, mass: 1 };

    expect(settleTimeMs(ringing)).toBeGreaterThan(SETTLE_TIME_MAX_MS);
    expect(settlesWithinBound(ringing)).toBe(false);
  });

  it('grows as damping falls', () => {
    const damped: SpringTransition = { type: 'spring', stiffness: 300, damping: 30, mass: 1 };
    const looser: SpringTransition = { type: 'spring', stiffness: 300, damping: 15, mass: 1 };

    expect(settleTimeMs(looser)).toBeGreaterThan(settleTimeMs(damped));
  });
});

/**
 * Integrate `m·x'' + c·x' + k·x = 0` from a unit displacement and report the last millisecond the
 * displacement is outside ±1%. Semi-implicit Euler at 0.1 ms, which is far finer than any spring
 * here needs and keeps the comparison honest.
 */
function simulateSettleMs(spring: SpringTransition): number {
  const dt = 0.0001;
  let position = 1;
  let velocity = 0;
  let lastOutside = 0;

  for (let step = 0; step * dt < 5; step += 1) {
    const acceleration = (-spring.stiffness * position - spring.damping * velocity) / spring.mass;
    velocity += acceleration * dt;
    position += velocity * dt;
    if (Math.abs(position) > SETTLE_TOLERANCE) lastOutside = step * dt;
  }

  return lastOutside * 1000;
}
