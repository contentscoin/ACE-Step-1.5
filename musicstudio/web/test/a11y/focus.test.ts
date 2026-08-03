/**
 * The focus indicator's geometry and its budget (Requirements 31.12, 31.14).
 *
 * **Validates: Requirements 31.12, 31.14**
 *
 * The last case is the one worth having: `src/a11y/focus.ts` and `src/styles/index.css` both hold
 * the ring offset, and that number **is** the boundary difference the clause bounds at 2 px. Two
 * copies is how a bound gets raised in one place, so the test reads the stylesheet.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FOCUS_BOUNDARY_MAX_PX,
  FOCUS_INDICATOR_MAX_DELAY_MS,
  FOCUS_RING_OFFSET_PX,
  FOCUS_RING_WIDTH_PX,
  TABBABLE_SELECTOR,
  focusBoundaryDifferencePx,
  focusRingWithinBudget,
  outlineRect,
} from '../../src/a11y/focus';

const ELEMENT = { top: 100, left: 50, width: 120, height: 32 };

describe('focusBoundaryDifferencePx', () => {
  it('is zero for a ring exactly on the element', () => {
    expect(focusBoundaryDifferencePx(ELEMENT, ELEMENT)).toBe(0);
  });

  it('reports the worst side rather than an average', () => {
    // Inset 4 px at the top, outset 4 px at the bottom: the two would cancel in an area or a
    // mean, and the ring looks wrong on both edges.
    const lopsided = { top: 104, left: 50, width: 120, height: 32 };
    expect(focusBoundaryDifferencePx(ELEMENT, lopsided)).toBe(4);
  });

  it('measures an outline as exactly its offset, on every side', () => {
    for (const offset of [0, 1, 2]) {
      expect(focusBoundaryDifferencePx(ELEMENT, outlineRect(ELEMENT, offset))).toBe(offset);
    }
  });
});

describe('the app’s ring', () => {
  it('is inside Requirement 31.14’s budget', () => {
    expect(focusRingWithinBudget(ELEMENT, outlineRect(ELEMENT))).toBe(true);
    expect(FOCUS_RING_OFFSET_PX).toBeLessThanOrEqual(FOCUS_BOUNDARY_MAX_PX);
  });

  it('uses the same numbers the stylesheet does', () => {
    const css = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'styles', 'index.css'),
      'utf8',
    );
    const offset = /--focus-ring-offset:\s*(\d+)px/.exec(css);
    const width = /--focus-ring-width:\s*(\d+)px/.exec(css);

    expect(offset).not.toBeNull();
    expect(width).not.toBeNull();
    // The two copies agree, so raising one for looks fails here rather than in production.
    expect(Number(offset?.[1])).toBe(FOCUS_RING_OFFSET_PX);
    expect(Number(width?.[1])).toBe(FOCUS_RING_WIDTH_PX);
  });

  it('draws with `outline`, which is what makes the 2 px bound hold mid-animation', () => {
    const css = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'styles', 'index.css'),
      'utf8',
    );
    // A `box-shadow` ring or a positioned pseudo-element would be laid out on the main thread
    // while the element transforms on the compositor, and the gap would be unbounded for as long
    // as a frame was late. The clause is only structurally satisfiable with an outline.
    expect(css).toMatch(/\*:focus-visible\s*\{[^}]*outline:/);
    expect(css).not.toMatch(/:focus-visible[^}]*box-shadow/);
  });

  it('states the indicator budget as Requirement 31.12 does', () => {
    expect(FOCUS_INDICATOR_MAX_DELAY_MS).toBe(100);
  });
});

describe('TABBABLE_SELECTOR', () => {
  it('excludes negative tabindex, which is programmatically focusable but not tabbable', () => {
    // The main region is `tabindex="-1"` on purpose — the skip link and the route effect reach it,
    // Tab does not. Including it would make the reading-order check complain about an element no
    // keyboard user visits.
    expect(TABBABLE_SELECTOR).toContain('[tabindex]:not([tabindex^="-"])');
    expect(TABBABLE_SELECTOR).not.toMatch(/\[tabindex\](?!:not)/);
  });

  it('excludes disabled controls, which no keyboard reaches', () => {
    for (const tag of ['button', 'input', 'select', 'textarea']) {
      expect(TABBABLE_SELECTOR).toContain(`${tag}:not([disabled])`);
    }
  });
});
