/**
 * Keyboard reach and status channels, in the DOM (Requirements 31.13, 31.14, 31.16, 32.16).
 *
 * **Validates: Requirements 31.13, 31.16, 32.16**
 *
 * ### What this file can and cannot claim
 *
 * happy-dom does no layout — every `getBoundingClientRect()` is zeros — so the *geometric* half of
 * Requirement 31.13 is not checkable here and is not attempted. What is checkable is the
 * structural half, which is what actually makes the clause hold: tab order **is** DOM order when
 * no element declares a positive `tabIndex`, so a rendered screen with none of those, plus the
 * static check's ban on the CSS that reorders a layout, is the guarantee.
 *
 * The geometry is measured for real by `scripts/verify-a11y-browser.mjs` against Chromium. Saying
 * which file establishes which half matters: a test named "tab order" that only counted elements
 * would read like the whole clause was covered.
 */

import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { STATED_STATUS_KINDS, STATUS_PRESENTATION } from '../../src/a11y/status';
import { TABBABLE_SELECTOR } from '../../src/a11y/focus';
import { MAIN_REGION_ID, MainRegion, SkipLink } from '../../src/a11y/SkipLink';
import { StatusMessage } from '../../src/components/StatusMessage';
import { App } from '../../src/App';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

describe('the rendered app (Req 31.13)', () => {
  it('declares no positive tabIndex, so tab order is DOM order', () => {
    render(<App />);

    const positive = [...globalThis.document.querySelectorAll('[tabindex]')].filter(
      (element) => Number(element.getAttribute('tabindex')) > 0,
    );
    expect(positive).toEqual([]);
  });

  it('puts the skip link first, so it is the first Tab stop', () => {
    render(<App />);

    const tabbable = [...globalThis.document.querySelectorAll(TABBABLE_SELECTOR)];
    expect(tabbable[0]?.textContent).toBe('본문으로 건너뛰기');
  });

  it('keeps the main region out of the tab sequence', () => {
    render(<App />);

    const region = globalThis.document.getElementById(MAIN_REGION_ID);
    expect(region?.getAttribute('tabindex')).toBe('-1');
    // Reachable by the skip link and by the route effect; skipped by Tab, which is what `-1` is.
    expect([...globalThis.document.querySelectorAll(TABBABLE_SELECTOR)]).not.toContain(region);
  });
});

describe('SkipLink', () => {
  it('stays in the tab order while hidden, rather than being display:none', () => {
    render(<SkipLink />);
    const link = screen.getByText('본문으로 건너뛰기');

    // The usual mistake removes it from the document until focus, which makes it unreachable —
    // a skip link nobody can tab to. Only its position moves.
    expect(link.style.display).not.toBe('none');
    expect(Number.parseInt(link.style.top, 10)).toBeLessThan(0);

    fireEvent.focus(link);
    expect(Number.parseInt(link.style.top, 10)).toBeGreaterThanOrEqual(0);

    fireEvent.blur(link);
    expect(Number.parseInt(link.style.top, 10)).toBeLessThan(0);
  });

  it('moves focus to the region rather than following the href', () => {
    render(
      <>
        <SkipLink />
        <MainRegion routeKey="a">본문</MainRegion>
      </>,
    );

    fireEvent.click(screen.getByText('본문으로 건너뛰기'));
    expect(globalThis.document.activeElement?.id).toBe(MAIN_REGION_ID);
  });
});

describe('MainRegion', () => {
  it('does not steal focus on first render', () => {
    render(<MainRegion routeKey="a">본문</MainRegion>);
    // A deep-linked user did not navigate anywhere; focusing on load would take focus from
    // wherever the browser restored it.
    expect(globalThis.document.activeElement?.id).not.toBe(MAIN_REGION_ID);
  });

  it('moves focus to the new screen when the route changes', () => {
    const { rerender } = render(<MainRegion routeKey="a">첫 화면</MainRegion>);
    expect(globalThis.document.activeElement?.id).not.toBe(MAIN_REGION_ID);

    act(() => {
      rerender(<MainRegion routeKey="b">다음 화면</MainRegion>);
    });

    // Otherwise the next Tab continues through the nav and the new screen is a dozen presses away.
    expect(globalThis.document.activeElement?.id).toBe(MAIN_REGION_ID);
  });
});

describe('StatusMessage (Reqs 31.16, 32.16)', () => {
  it('carries a shape and a word as well as a colour', () => {
    render(<StatusMessage kind="error">다운로드가 거부되었습니다.</StatusMessage>);

    const box = screen.getByRole('alert');
    expect(box.dataset.status).toBe('error');
    expect(box.textContent).toContain(STATUS_PRESENTATION.error.shape);
    expect(box.textContent).toContain(STATUS_PRESENTATION.error.label);
  });

  it('tells the three stated states apart in both non-colour channels', () => {
    const shapes = new Set<string>();
    const labels = new Set<string>();

    for (const kind of STATED_STATUS_KINDS) {
      cleanup();
      render(<StatusMessage kind={kind}>상태</StatusMessage>);
      const text = screen.getByRole('alert').textContent ?? '';
      shapes.add(STATUS_PRESENTATION[kind].shape);
      labels.add(STATUS_PRESENTATION[kind].label);
      expect(text).toContain(STATUS_PRESENTATION[kind].shape);
      expect(text).toContain(STATUS_PRESENTATION[kind].label);
    }

    // Two channels, each pairwise distinct. Colour is deliberately not asserted: it is the third
    // channel, and the clause is satisfied without it.
    expect(shapes.size).toBe(STATED_STATUS_KINDS.length);
    expect(labels.size).toBe(STATED_STATUS_KINDS.length);
  });

  it('hides the shape from screen readers, because the label already says it', () => {
    render(<StatusMessage kind="warning">주의</StatusMessage>);
    const shape = screen.getByRole('alert').querySelector('[aria-hidden="true"]');
    expect(shape?.textContent).toBe(STATUS_PRESENTATION.warning.shape);
  });

  it('uses `status` rather than `alert` when asked, so it does not interrupt', () => {
    render(
      <StatusMessage kind="neutral" role="status">
        재생 횟수가 갱신되었습니다.
      </StatusMessage>,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
