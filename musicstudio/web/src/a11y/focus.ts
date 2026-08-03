/**
 * The focus indicator's budget and its geometry (Requirements 31.12, 31.14).
 *
 * > … 포커스 이동 후 100밀리초 이내에 포커스 표시를 나타내고, 애니메이션 재생 중에도 포커스 표시
 * > 영역과 대상 구성요소 화면 영역의 경계 차이를 2 CSS 픽셀 이하로 유지한다
 *
 * ### Why an `outline` makes the 2 px clause structural rather than measured
 *
 * The clause bounds the difference **while an animation plays**. Anything drawn *beside* the
 * element — a positioned pseudo-element, a sibling ring, a portal — has to be kept in step with a
 * transform that is running on the compositor, and it cannot be: the ring's layout position
 * updates on the main thread and the element's transform does not. The gap is unbounded for as
 * long as the frame is late.
 *
 * An `outline` is painted on the element's own border box, so it transforms *with* the element.
 * The difference is then exactly `outline-offset`, in every frame, whatever the animation is
 * doing. That is what `FOCUS_RING_OFFSET_PX` is: not a design choice but the entire measured
 * quantity, which is why it is a constant here and a custom property in the stylesheet rather
 * than a number typed into CSS.
 *
 * `focusBoundaryDifferencePx` exists so a test can check the two agree — the failure this guards
 * against is someone raising the offset to 4 px for looks and the criterion silently going false.
 */

/** Requirement 31.14's ceiling. */
export const FOCUS_BOUNDARY_MAX_PX = 2;

/** Requirements 31.12 and 31.14's budget for the indicator to appear. */
export const FOCUS_INDICATOR_MAX_DELAY_MS = 100;

/**
 * The offset the stylesheet uses, as a number.
 *
 * `index.css` reads it from `--focus-ring-offset`, and `test/a11y/focus.test.ts` asserts the two
 * are the same value. Two copies of a number is how a bound gets raised in one place only.
 */
export const FOCUS_RING_OFFSET_PX = 2;

export const FOCUS_RING_WIDTH_PX = 2;

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How far the indicator's boundary sits from the element's, on the worst side.
 *
 * The *boundary* difference, not the area difference: the clause is about how far the ring is
 * from the thing it is marking, and a ring inset on one side and outset on the other would
 * average to zero while looking wrong on both.
 */
export function focusBoundaryDifferencePx(element: Rect, indicator: Rect): number {
  return Math.max(
    Math.abs(indicator.top - element.top),
    Math.abs(indicator.left - element.left),
    Math.abs(indicator.top + indicator.height - (element.top + element.height)),
    Math.abs(indicator.left + indicator.width - (element.left + element.width)),
  );
}

/** The rect an `outline` with this offset paints, given the element's box. */
export function outlineRect(element: Rect, offsetPx: number = FOCUS_RING_OFFSET_PX): Rect {
  return {
    top: element.top - offsetPx,
    left: element.left - offsetPx,
    width: element.width + offsetPx * 2,
    height: element.height + offsetPx * 2,
  };
}

export function focusRingWithinBudget(element: Rect, indicator: Rect): boolean {
  return focusBoundaryDifferencePx(element, indicator) <= FOCUS_BOUNDARY_MAX_PX;
}

/**
 * The selector for "things a keyboard reaches", as one string.
 *
 * `tabindex="-1"` is excluded because it is programmatically focusable but not tabbable, and
 * Requirement 31.13 is about the **tab** order. Including it would make the reading-order check
 * complain about the skip-link target, which is deliberately unreachable by tab.
 */
export const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex^="-"])',
].join(',');
