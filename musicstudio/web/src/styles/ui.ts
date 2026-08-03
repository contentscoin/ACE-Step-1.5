/**
 * The handful of shared style objects the screens use.
 *
 * Inline style objects rather than Tailwind classes for the *structural* pieces — a panel, a row,
 * a field — because they are read and reused as values here, and a class string cannot be composed
 * or conditioned without a helper. Tailwind stays in the markup for one-off spacing and colour,
 * which is what it is good at.
 *
 * Colours come from CSS custom properties so the light and dark palettes of design §8 are one
 * declaration in `index.css` rather than a conditional in every component.
 */

import type { CSSProperties } from 'react';

/*
 * Longhand `borderWidth`/`borderStyle`/`borderColor` and `fontFamily`/`fontSize` rather than the
 * `border` and `font` shorthands, because these objects are *spread over*: `primaryButton` sets
 * `borderColor`, and React warns — rightly — that removing a longhand while a conflicting
 * shorthand is set produces a style that depends on property order.
 */
export const panel: CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  borderRadius: 12,
  padding: 16,
  background: 'var(--surface)',
};

export const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

export const column: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

export const label: CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  opacity: 0.8,
};

export const input: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  background: 'var(--field)',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 'inherit',
};

export const button: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  background: 'var(--field)',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  cursor: 'pointer',
  // A button beside a flexible input must not be the thing that shrinks: 저장 wrapping to two
  // lines is what happens when it does.
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

export const primaryButton: CSSProperties = {
  ...button,
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: 'var(--accent-ink)',
  fontWeight: 600,
};

export const chip: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  fontSize: 12,
  opacity: 0.85,
};

// The refusal box used to live here as a style object. It is now `components/StatusMessage.tsx`,
// because Requirements 31.16 and 32.16 need a refusal to carry a *shape* and a *word* as well as a
// colour, and a `CSSProperties` value cannot render either. Every former user of it now renders
// `<StatusMessage kind="error">`.

export const meta: CSSProperties = {
  fontSize: 12,
  opacity: 0.65,
};

/** Numbers that change in place — a percentage, a timecode — must not reflow as they tick. */
export const tabular: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
