/**
 * Skip to the screen, and move focus there when the screen changes.
 *
 * ### The skip link is visible when focused and only then
 *
 * The usual mistake is `display: none` until focus, which removes it from the tab order — a skip
 * link nobody can reach. It is therefore always in the document and always tabbable, and only its
 * *position* changes: off-screen until focused, in the corner once it is. A keyboard user's first
 * Tab lands on it; a pointer user never sees it.
 *
 * ### Focus moves on navigation, to the region rather than to a control
 *
 * A hash route change swaps the whole screen under a focus that is still on the nav link that was
 * clicked. Leaving it there means the next Tab continues through the *nav*, and the new screen is
 * a dozen presses away. Moving it to the first control would be worse — it would skip the screen's
 * heading, and a screen reader user would never hear what they navigated to.
 *
 * So focus goes to the region itself, which is `tabIndex={-1}`: programmatically focusable,
 * skipped by Tab. The reader announces the region and its heading; the next Tab enters the screen
 * from the top. `tabindex="-1"` is also why `TABBABLE_SELECTOR` excludes it — see `focus.ts`.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export const MAIN_REGION_ID = 'main-content';

export function SkipLink(): ReactNode {
  return (
    <a
      href={`#${MAIN_REGION_ID}`}
      // The one place a click on a hash link must not go through the router: this is a
      // same-document jump, not a route.
      onClick={(event) => {
        event.preventDefault();
        globalThis.document.getElementById(MAIN_REGION_ID)?.focus();
      }}
      style={{
        position: 'absolute',
        left: 8,
        top: -60,
        zIndex: 100,
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid var(--accent)',
        background: 'var(--surface)',
        color: 'inherit',
        textDecoration: 'none',
      }}
      onFocus={(event) => {
        event.currentTarget.style.top = '8px';
      }}
      onBlur={(event) => {
        event.currentTarget.style.top = '-60px';
      }}
    >
      본문으로 건너뛰기
    </a>
  );
}

export interface MainRegionProps {
  /** Changes when the screen changes; focus follows it. */
  readonly routeKey: string;
  readonly children: ReactNode;
}

export function MainRegion({ routeKey, children }: MainRegionProps): ReactNode {
  const region = useRef<HTMLDivElement | null>(null);
  const first = useRef(true);

  useEffect(() => {
    // Not on the first render: focusing on load steals it from wherever the browser restored it,
    // and a user who deep-linked did not navigate anywhere.
    if (first.current) {
      first.current = false;
      return;
    }
    region.current?.focus();
  }, [routeKey]);

  return (
    <div
      id={MAIN_REGION_ID}
      ref={region}
      // `-1`: reachable by the skip link and by the route effect, invisible to Tab.
      tabIndex={-1}
      role="region"
      aria-label="본문"
      // No `outline: none` here, though a ring around the whole content area is visually heavy.
      // Focus reaches this element only via the skip link or a route change — both moments when a
      // keyboard user needs to be told where focus went. Suppressing it would make the skip link
      // land somewhere invisible, which is the failure the link exists to prevent.
    >
      {children}
    </div>
  );
}
