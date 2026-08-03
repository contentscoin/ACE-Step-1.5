import { render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TextReveal } from '../../src/components/amicro/TextReveal';
import { MOTION_PRESET_IDS, MOTION_PRESETS } from '../../src/motion/presets';
import {
  REDUCED_MOTION_MAX_DURATION_MS,
  REDUCED_MOTION_QUERY,
  matchesReducedMotion,
  playsFrames,
  transitionFor,
} from '../../src/motion/reduced-motion';

/**
 * Reduced motion.
 *
 * **Validates: Requirements 31.8, 31.9, 31.10, 31.20**
 *
 * The decision is a pure function, so most of this is about *values*: "plays zero frames" is a
 * claim about what a component hands to Motion, and asserting it that way is both exact and
 * possible — counting rendered frames in a test environment is neither.
 *
 * The last block is the one that needs a DOM: 31.20 requires a change to the setting to take effect
 * **without a reload**, which is only observable by changing the media query while a component is
 * mounted.
 */

/** A `matchMedia` a test can move. Returns the controls. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initial;

  const media = {
    get matches() {
      return matches;
    },
    media: REDUCED_MOTION_QUERY,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };

  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => media,
  });

  return {
    set(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'matchMedia');
});

describe('Requirement 31.9 — decorative animation plays zero frames', () => {
  it('resolves to an instant transition, not a fast one', () => {
    const resolved = transitionFor('gentle', 'decorative', true);

    expect(resolved.kind).toBe('instant');
    expect(playsFrames(resolved)).toBe(false);
    expect(resolved.transition).toEqual({ duration: 0 });
  });

  it('renders the end state immediately, with no per-word animation', () => {
    installMatchMedia(true);

    const { container } = render(<TextReveal text="늦은 밤 도심을 달려" />);

    // The whole string in one node: a stagger of zero would still be N animating spans.
    expect(screen.getByText('늦은 밤 도심을 달려')).toBeDefined();
    expect(container.querySelectorAll('span').length).toBe(1);
  });
});

describe('Requirement 31.10 — a state change still animates, inside 200 ms', () => {
  it('resolves to a timed transition at the ceiling', () => {
    const resolved = transitionFor('snappy', 'state_transfer', true);

    expect(resolved.kind).toBe('timed');
    expect(playsFrames(resolved)).toBe(true);
    if (resolved.kind !== 'timed') return;
    // Motion's unit is seconds; the criterion's is milliseconds.
    expect(resolved.transition.duration * 1000).toBeLessThanOrEqual(REDUCED_MOTION_MAX_DURATION_MS);
  });

  it('never returns a spring under reduced motion, for any preset', () => {
    // A spring has no duration to bound, so leaving one in place would make 31.10 unenforceable.
    for (const preset of MOTION_PRESET_IDS) {
      expect(transitionFor(preset, 'state_transfer', true).kind).toBe('timed');
      expect(transitionFor(preset, 'decorative', true).kind).toBe('instant');
    }
  });
});

describe('with reduced motion off', () => {
  it('uses the preset, unchanged, for both purposes', () => {
    for (const preset of MOTION_PRESET_IDS) {
      for (const purpose of ['state_transfer', 'decorative'] as const) {
        const resolved = transitionFor(preset, purpose, false);
        expect(resolved.kind).toBe('spring');
        expect(resolved.transition).toBe(MOTION_PRESETS[preset]);
      }
    }
  });
});

describe('Requirements 31.8, 31.20 — the hook, and changing the setting live', () => {
  it('reads the media query', () => {
    installMatchMedia(true);
    expect(matchesReducedMotion()).toBe(true);
  });

  it('reports false when the environment has no matchMedia at all', () => {
    // Server rendering, or a very old browser. Defaulting to "reduce" would silently strip motion
    // for everyone in that environment.
    expect(matchesReducedMotion()).toBe(false);
  });

  it('applies a change with no remount', () => {
    const media = installMatchMedia(false);

    const { container } = render(<TextReveal text="하나 둘 셋" />);
    // Animating: one span per word.
    expect(container.querySelectorAll('span').length).toBeGreaterThan(1);

    act(() => {
      media.set(true);
    });

    // Same tree, no reload — now the end state, in one node.
    expect(container.querySelectorAll('span').length).toBe(1);
    expect(screen.getByText('하나 둘 셋')).toBeDefined();
  });
});
