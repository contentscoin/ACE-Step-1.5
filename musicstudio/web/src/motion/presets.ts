/**
 * `Amicro_Motion_Preset` — the five spring transitions every animated component uses
 * (Requirements 31.4, 31.5, 31.19; design §8.2).
 *
 * ### This module is the only place spring numbers appear
 *
 * Requirement 31.4 says every animated component's spring transition must equal *exactly one* of
 * five presets, and 31.5 fails the build over any component that writes stiffness, damping, mass or
 * duration as a numeric literal instead. Both criteria are about the same thing: a transition
 * should be a *name* everywhere it is used, so that changing how the product feels is one edit
 * rather than a search-and-replace across components that have each drifted a little.
 *
 * `scripts/check-motion-presets.mjs` enforces it, and it exempts exactly this file — the numbers
 * have to live somewhere, and the exemption is a single path rather than a pattern a component
 * could accidentally match.
 *
 * ### Why these five, and why each settles inside 600 ms
 *
 * Requirement 31.19 caps the **settle time** — when the value reaches and stays within 1% of its
 * target — at 600 ms for every transition. That is not a property of a spring you can eyeball:
 * `stiffness: 120, damping: 8` looks reasonable and rings for well over a second. So the settle
 * time is *computed* from the spring constants (`settleTimeMs` below), and
 * `test/motion/presets.test.ts` asserts the bound over all five. Choosing the constants and then
 * checking them is the only order that works; picking a number that "feels right" and hoping is
 * how a bouncy preset violates an invariant nobody re-measures.
 */

export const MOTION_PRESET_IDS = ['snappy', 'bouncy', 'smooth', 'gentle', 'stiff'] as const;

export type MotionPresetId = (typeof MOTION_PRESET_IDS)[number];

/** A spring, in Motion's own parameter names. */
export interface SpringTransition {
  readonly type: 'spring';
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

/**
 * The five presets.
 *
 * - `snappy` — near-critically damped and fast: the default for state changes.
 * - `bouncy` — deliberately under-damped, for a decorative flourish that reads as playful.
 * - `smooth` — critically damped, no overshoot, medium speed.
 * - `gentle` — slower and soft, for large surfaces where a fast move would be startling.
 * - `stiff` — the fastest, for small elements where any delay reads as lag.
 */
export const MOTION_PRESETS: Readonly<Record<MotionPresetId, SpringTransition>> = {
  snappy: { type: 'spring', stiffness: 420, damping: 32, mass: 1 },
  bouncy: { type: 'spring', stiffness: 380, damping: 18, mass: 1 },
  smooth: { type: 'spring', stiffness: 260, damping: 32, mass: 1 },
  gentle: { type: 'spring', stiffness: 170, damping: 26, mass: 1 },
  stiff: { type: 'spring', stiffness: 620, damping: 38, mass: 1 },
};

export function isMotionPresetId(value: unknown): value is MotionPresetId {
  return typeof value === 'string' && (MOTION_PRESET_IDS as readonly string[]).includes(value);
}

/** Requirement 31.19's threshold: within 1% of the target, and staying there. */
export const SETTLE_TOLERANCE = 0.01;

/** Requirement 31.19's ceiling, milliseconds. */
export const SETTLE_TIME_MAX_MS = 600;

/**
 * When a spring has settled, in milliseconds.
 *
 * From the standard second-order response to a unit displacement released at rest, with
 * `ω₀ = √(k/m)` and `ζ = c / (2√(km))`.
 *
 * **Under-damped (ζ < 1)** has a closed form. The response is
 * `x(t) = (1/√(1−ζ²))·e^(−ζω₀t)·cos(ω_d t − φ)`, so the *envelope* — which is what "within 1% and
 * staying there" is about — falls below the tolerance at
 *
 * ```
 *   t = ln(A / tolerance) / (ζω₀),   A = 1 / √(1−ζ²)
 * ```
 *
 * That amplitude factor `A` is easy to drop and it is not small: at ζ = 0.99 it is 7×, which is
 * two-and-a-half more decay constants of settling. A version of this function without it under-
 * reported `snappy` by 30 ms and `gentle` by considerably more — caught only because
 * `test/motion/presets.test.ts` compares every preset against an integrated spring rather than
 * trusting the algebra. The comparison is kept for exactly that reason.
 *
 * **Critically and over-damped (ζ ≥ 1)** has no clean inverse — `(1 + ω₀t)e^(−ω₀t) = tolerance` is
 * transcendental — so it is bisected over the exact displacement below. Deterministic, and no
 * fudge factor standing in for a solve.
 */
export function settleTimeMs(spring: SpringTransition): number {
  const omega = Math.sqrt(spring.stiffness / spring.mass);
  const zeta = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));

  if (zeta < 1) {
    const amplitude = 1 / Math.sqrt(1 - zeta * zeta);
    return (Math.log(amplitude / SETTLE_TOLERANCE) / (zeta * omega)) * 1000;
  }

  return bisectSettleSeconds(omega, zeta) * 1000;
}

/** Displacement of a critically or over-damped spring released from 1 at rest. */
function overDampedDisplacement(omega: number, zeta: number, t: number): number {
  if (zeta === 1) return (1 + omega * t) * Math.exp(-omega * t);

  const root = omega * Math.sqrt(zeta * zeta - 1);
  const slow = -omega * zeta + root;
  const fast = -omega * zeta - root;
  return (fast * Math.exp(slow * t) - slow * Math.exp(fast * t)) / (fast - slow);
}

/** The last moment the displacement is outside the tolerance band, to a millisecond. */
function bisectSettleSeconds(omega: number, zeta: number): number {
  let low = 0;
  // Ten decay constants of the slowest mode is past settling for any spring a UI would use.
  let high = (10 / (omega * (zeta - Math.sqrt(Math.max(0, zeta * zeta - 1))))) || 10;

  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (Math.abs(overDampedDisplacement(omega, zeta, middle)) > SETTLE_TOLERANCE) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return high;
}

export function settlesWithinBound(spring: SpringTransition): boolean {
  return settleTimeMs(spring) <= SETTLE_TIME_MAX_MS;
}

/**
 * Requirement 31.9's "zero frames", as a transition a component can hand straight to Motion.
 *
 * It lives here, with the other numbers, for the reason the static check exists: a component
 * writing `{ duration: 0 }` inline is a component writing a spring parameter as a literal, and the
 * check cannot tell that particular zero from a hand-tuned 0.3. Naming it means every component
 * passes `resolved.transition` unconditionally and never types a number at all.
 */
export const INSTANT_TRANSITION = { duration: 0 } as const;
