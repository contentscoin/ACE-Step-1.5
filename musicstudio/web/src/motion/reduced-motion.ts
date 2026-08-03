/**
 * Reduced motion (Requirements 31.8, 31.9, 31.10, 31.20; design §8.2).
 *
 * Two pieces, deliberately separated:
 *
 * - **`transitionFor`** — the decision, a pure function of the classification and the setting. It
 *   is where 31.9 and 31.10 live, and it is testable with no DOM at all, which matters because
 *   "a decorative animation plays zero frames" is an assertion about a *value*, not about pixels.
 * - **`useReducedMotion`** — the hook 31.8 names, and nothing more: it reads the media query and
 *   subscribes to changes.
 *
 * ### Why the hook subscribes rather than reads once
 *
 * Requirement 31.20 requires a change to `prefers-reduced-motion` to reach **running and
 * subsequent animations within one second, with no reload**. A hook that read `matchMedia` once at
 * mount would satisfy every test that sets the preference before rendering and fail the only case
 * the criterion is about — the user changing the setting while the app is open. So it listens, and
 * React re-renders; the components read `transitionFor` on every render, so a running animation
 * picks up the new transition on the next frame rather than after a second.
 */

import { useEffect, useState } from 'react';

import type { MotionPurpose } from './classification';
import {
  INSTANT_TRANSITION,
  MOTION_PRESETS,
  type MotionPresetId,
  type SpringTransition,
} from './presets';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Requirement 31.10's ceiling for a state-transferring animation under reduced motion. */
export const REDUCED_MOTION_MAX_DURATION_MS = 200;

/**
 * What a component animates with.
 *
 * A discriminated union rather than a spring with a `duration` bolted on, because 31.9's
 * "zero frames" is not a fast animation — it is *no* animation, and a component has to be able to
 * tell the difference in order to render the end state immediately.
 */
export type ResolvedTransition =
  | { readonly kind: 'spring'; readonly transition: SpringTransition }
  /** Requirement 31.10 — a state change still animates, but inside 200 ms. */
  | { readonly kind: 'timed'; readonly transition: { readonly duration: number; readonly ease: 'easeOut' } }
  /**
   * Requirement 31.9 — no frames; the component renders its end state.
   *
   * Carries a transition anyway so a caller can pass `resolved.transition` unconditionally. A
   * component that had to branch to produce one would be writing the zero itself, which is the
   * literal the static check of 31.5 refuses.
   */
  | { readonly kind: 'instant'; readonly transition: typeof INSTANT_TRANSITION };

/**
 * The rule of 31.9 and 31.10, in one function.
 *
 * `duration` is in **seconds** for the timed case because that is Motion's unit; the milliseconds
 * of the criterion are converted here rather than at each call site, so no component can convert
 * it wrongly and still look right.
 */
export function transitionFor(
  presetId: MotionPresetId,
  purpose: MotionPurpose,
  reducedMotion: boolean,
): ResolvedTransition {
  if (!reducedMotion) {
    return { kind: 'spring', transition: MOTION_PRESETS[presetId] };
  }

  if (purpose === 'decorative') return { kind: 'instant', transition: INSTANT_TRANSITION };

  return {
    kind: 'timed',
    transition: { duration: REDUCED_MOTION_MAX_DURATION_MS / 1000, ease: 'easeOut' },
  };
}

/** Whether a resolved transition plays any frames at all — 31.9's observable claim. */
export function playsFrames(resolved: ResolvedTransition): boolean {
  return resolved.kind !== 'instant';
}

/** Requirement 31.8 — `use-reduced-motion`. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => matchesReducedMotion());

  useEffect(() => {
    const media = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    if (media === undefined) return;

    const onChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    media.addEventListener('change', onChange);
    // The setting may have changed between the initial render and this effect.
    setReduced(media.matches);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  return reduced;
}

/** Read once. Exported so a test can assert the default without rendering. */
export function matchesReducedMotion(): boolean {
  return globalThis.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}
