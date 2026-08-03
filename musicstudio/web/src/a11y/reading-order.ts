/**
 * Tab order against visual order (Requirement 31.13).
 *
 * > THE MusicStudio SHALL 애니메이션이 적용된 모든 대화형 구성요소에 대해 키보드 탭 이동 순서를
 * > 시각적 배치 순서와 일치하게 유지한다
 *
 * ### The rule needs a definition of "visual order", and the obvious one is wrong
 *
 * Sorting by `top` and breaking ties on `left` sounds right and is not: two controls in the same
 * visual row almost never share a `top` to the pixel. A 14 px label and a 34 px button sitting
 * side by side differ by ten pixels of vertical centring, and a strict sort puts the taller one
 * first — reporting a violation for a row that reads perfectly.
 *
 * So elements are grouped into **bands**: two elements are in the same row when their vertical
 * spans overlap by more than `ROW_OVERLAP_RATIO` of the shorter one. Within a band, order is by
 * `left`. This is the same rule a reader's eye applies, and it is why the comparison is worth
 * writing down rather than eyeballing.
 *
 * ### What this module is for
 *
 * It is not a runtime behaviour — nothing calls it in the app. It is the *specification* of
 * Requirement 31.13 in executable form, so `test/a11y/tab-order.test.tsx` can render the real
 * screens, read their real geometry, and assert the property. A criterion that could only be
 * checked by tabbing through a browser by hand is a criterion that gets checked once.
 */

/** A focusable element reduced to what the rule needs. */
export interface FocusableBox {
  /** Position in DOM/tab order. */
  readonly index: number;
  readonly label: string;
  readonly top: number;
  readonly left: number;
  readonly height: number;
  readonly width: number;
}

/**
 * How much two elements' vertical spans must overlap to count as one row.
 *
 * 0.5 rather than "any overlap": a tall panel that happens to graze the top of the control below
 * it is not in that control's row, and treating it as one would merge the whole page into a
 * single band and make the check vacuous.
 */
export const ROW_OVERLAP_RATIO = 0.5;

function sameRow(a: FocusableBox, b: FocusableBox): boolean {
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  const shorter = Math.min(a.height, b.height);
  if (shorter <= 0) return Math.abs(a.top - b.top) < 1;
  return overlap / shorter > ROW_OVERLAP_RATIO;
}

/**
 * Group boxes into visual rows, top to bottom.
 *
 * A band grows while the next element still overlaps the band's *first* member. Comparing against
 * the first rather than against the running union is deliberate: a union creeps downward one
 * element at a time and would eventually swallow a genuinely lower row.
 */
export function visualRows(boxes: readonly FocusableBox[]): readonly (readonly FocusableBox[])[] {
  const byTop = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: FocusableBox[][] = [];

  for (const box of byTop) {
    const current = rows[rows.length - 1];
    const anchor = current?.[0];
    if (current !== undefined && anchor !== undefined && sameRow(anchor, box)) {
      current.push(box);
    } else {
      rows.push([box]);
    }
  }

  return rows;
}

/** The order a reader's eye takes: rows top to bottom, elements left to right within a row. */
export function readingOrder(boxes: readonly FocusableBox[]): readonly FocusableBox[] {
  return visualRows(boxes).flatMap((row) => [...row].sort((a, b) => a.left - b.left));
}

export interface OrderMismatch {
  readonly position: number;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Where tab order and reading order disagree.
 *
 * Returns every disagreement rather than the first, for the same reason Requirements 3.5 and 4.6
 * return every violated field: a developer fixing one and re-running to find the next is a
 * developer who gives up on the third.
 */
export function orderMismatches(boxes: readonly FocusableBox[]): readonly OrderMismatch[] {
  const tabOrder = [...boxes].sort((a, b) => a.index - b.index);
  const visual = readingOrder(boxes);

  const mismatches: OrderMismatch[] = [];
  for (const [position, expected] of visual.entries()) {
    const actual = tabOrder[position];
    if (actual === undefined || actual.index !== expected.index) {
      mismatches.push({
        position,
        expected: expected.label,
        actual: actual?.label ?? '(없음)',
      });
    }
  }
  return mismatches;
}

export function tabOrderMatchesVisualOrder(boxes: readonly FocusableBox[]): boolean {
  return orderMismatches(boxes).length === 0;
}
