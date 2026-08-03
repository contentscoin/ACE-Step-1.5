/**
 * A state the user has to notice, shown in three channels (Requirements 31.16, 32.16).
 *
 * Replaces the bare red boxes the screens used to render. A red border says "error" to a reader
 * who can see red on this background; the shape and the word say it to everyone, and they survive
 * a greyscale screenshot, a colour-blind reader and a screen reader alike.
 *
 * `role` is a parameter rather than always `alert`, because the two are not interchangeable: an
 * `alert` interrupts a screen reader mid-sentence, which is right for a refusal the user is
 * waiting on and wrong for a count that just updated. The refusals pass `alert`; the announcer
 * uses `status`.
 */

import type { ReactNode } from 'react';

import { statusPresentation, type StatusKind } from '../a11y/status';
import { chip, panel, row } from '../styles/ui';

export interface StatusMessageProps {
  readonly kind: StatusKind;
  readonly children: ReactNode;
  readonly role?: 'alert' | 'status';
  /** Extra styling for the box, not for the channels. */
  readonly style?: React.CSSProperties;
}

export function StatusMessage({
  kind,
  children,
  role = 'alert',
  style,
}: StatusMessageProps): ReactNode {
  const presentation = statusPresentation(kind);

  return (
    <div
      role={role}
      data-status={kind}
      style={{
        ...panel,
        ...row,
        alignItems: 'flex-start',
        borderColor: presentation.tone,
        background: presentation.surface,
        fontSize: 13,
        ...style,
      }}
    >
      {/* Channel 1: the shape. `aria-hidden` because channel 2 already says it in words, and a
          screen reader announcing "black circle 오류" reads the state twice. */}
      <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1.4 }}>
        {presentation.shape}
      </span>
      <div style={{ flex: 1 }}>
        {/* Channel 2: the word. */}
        <span style={chip}>{presentation.label}</span>
        <div style={{ marginTop: 6 }}>{children}</div>
      </div>
    </div>
  );
}
