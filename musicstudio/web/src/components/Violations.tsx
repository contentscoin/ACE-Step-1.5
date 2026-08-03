/**
 * A refusal, with what was allowed (Requirements 3.5, 4.6).
 *
 * Both criteria say the refusal must carry **the offending field and its permitted range** — not
 * "invalid input". So the allowance is rendered from the violation's own `allowed` shape rather
 * than from a message table that would have to be kept in step with the validator: whatever the
 * domain decided the bound was, that is what the screen shows.
 *
 * All violations are listed, because `validateSongRequest` returns all of them. A form that showed
 * the first would make a user with three bad fields fix them one round trip at a time.
 */

import type { ReactNode } from 'react';

import type { SongFieldAllowance, SongFieldViolation } from '@domain/song/violation';
import { refusal } from '../styles/ui';

export function describeAllowance(allowed: SongFieldAllowance): string {
  switch (allowed.kind) {
    case 'range':
      return `${String(allowed.min)} 이상 ${String(allowed.max)} 이하${allowed.integer ? ' 정수' : ''}`;
    case 'length':
      return `${String(allowed.minLength)}자 이상 ${String(allowed.maxLength)}자 이하`;
    case 'enum':
      return `허용값: ${allowed.values.slice(0, 8).map(String).join(', ')}${
        allowed.values.length > 8 ? ` 외 ${String(allowed.values.length - 8)}개` : ''
      }`;
  }
}

export interface ViolationsProps {
  readonly violations: readonly SongFieldViolation[];
}

export function Violations({ violations }: ViolationsProps): ReactNode {
  if (violations.length === 0) return null;

  return (
    <div style={refusal} role="alert">
      <strong>요청이 거부되었습니다 — {violations.length}건</strong>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
        {violations.map((violation) => (
          <li key={`${violation.field}-${String(violation.received)}`}>
            <code>{violation.field}</code>: {String(violation.received)} — {describeAllowance(violation.allowed)}
          </li>
        ))}
      </ul>
    </div>
  );
}
