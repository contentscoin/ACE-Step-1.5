/**
 * The reading-order rule itself (Requirement 31.13).
 *
 * **Validates: Requirement 31.13**
 *
 * `tab-order.test.tsx` applies this to the real screens. This file checks the rule is the right
 * rule — in particular that it does not report a violation for a row whose controls are of
 * different heights, which is the case a naive top-then-left sort gets wrong and which occurs on
 * every screen in this app.
 */

import { describe, expect, it } from 'vitest';

import {
  ROW_OVERLAP_RATIO,
  orderMismatches,
  readingOrder,
  tabOrderMatchesVisualOrder,
  visualRows,
  type FocusableBox,
} from '../../src/a11y/reading-order';

function box(
  index: number,
  label: string,
  top: number,
  left: number,
  height = 32,
  width = 100,
): FocusableBox {
  return { index, label, top, left, height, width };
}

describe('visualRows', () => {
  it('puts controls of different heights in one row when they overlap', () => {
    // A 16 px label beside a 36 px button, vertically centred: tops differ by 10 px and they are
    // plainly one row. A `top`-sorted comparison would call the taller one first and report a
    // violation on a layout that reads perfectly.
    const rows = visualRows([box(0, 'label', 110, 0, 16), box(1, 'button', 100, 200, 36)]);
    expect(rows).toHaveLength(1);
  });

  it('does not merge rows that merely graze', () => {
    // One pixel of overlap is not a row; if it were, a tall panel would swallow the control below
    // it and the check would be vacuous.
    const rows = visualRows([box(0, 'above', 0, 0, 40), box(1, 'below', 39, 0, 40)]);
    expect(rows).toHaveLength(2);
  });

  it('uses the band anchor rather than the running union', () => {
    // Three boxes each overlapping the previous by just over half, drifting downward. Against a
    // growing union they would be one row; against the first, the third has left it.
    const step = 32 * (1 - ROW_OVERLAP_RATIO) + 2;
    const rows = visualRows([
      box(0, 'a', 0, 0),
      box(1, 'b', step, 100),
      box(2, 'c', step * 2, 200),
    ]);
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe('readingOrder', () => {
  it('reads rows top to bottom and each row left to right', () => {
    const order = readingOrder([
      box(0, 'b', 0, 100),
      box(1, 'a', 0, 0),
      box(2, 'd', 100, 100),
      box(3, 'c', 100, 0),
    ]);
    expect(order.map((entry) => entry.label)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('orderMismatches', () => {
  it('is empty when tab order already reads correctly', () => {
    const boxes = [box(0, 'a', 0, 0), box(1, 'b', 0, 100), box(2, 'c', 100, 0)];
    expect(orderMismatches(boxes)).toEqual([]);
    expect(tabOrderMatchesVisualOrder(boxes)).toBe(true);
  });

  it('names both sides of every disagreement, not just the first', () => {
    // Tab order is the reverse of reading order.
    const boxes = [box(0, 'c', 100, 0), box(1, 'b', 0, 100), box(2, 'a', 0, 0)];
    const mismatches = orderMismatches(boxes);

    expect(mismatches.length).toBeGreaterThan(1);
    expect(mismatches[0]).toEqual({ position: 0, expected: 'a', actual: 'c' });
    // A developer fixing one and re-running to find the next gives up on the third — the same
    // reason Requirements 3.5 and 4.6 return every violated field at once.
    expect(mismatches.map((entry) => entry.expected)).toContain('c');
  });
});
