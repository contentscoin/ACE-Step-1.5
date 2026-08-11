/**
 * Says, above everything else, that this build is talking to the demo backend.
 *
 * ### Why a banner and not a footnote
 *
 * Every screen in this app fills the same panels whether the answers came from the demo backend or
 * from the gateway — that is the point of the `StudioApi` seam, and it is also the hazard. A
 * visitor arriving at the deployed link sees a generation form, submits it, watches a progress
 * percentage, and reaches an asset with a waveform and a play button. Nothing in that sequence
 * tells them no model ran. The product already holds the principle this rests on: Requirement 16.5
 * refuses to let a listener believe the wrong thing about where audio came from. Synthetic
 * material presented in the places reserved for generated material is the same error one level up.
 *
 * So it sits at the top of the shell, before the navigation, and it is not dismissible. A banner
 * the user can close is one they will close, and the statement has to survive the whole session
 * because the misunderstanding it prevents can happen on any screen.
 *
 * ### Why it reads the backend rather than a build flag
 *
 * An environment variable would be a second source of truth about which backend is wired, and the
 * two would disagree on the first deployment that sets one and injects the other. `api.backend` is
 * the backend answering for itself, so the banner disappears exactly when a gateway is connected —
 * no build configuration to remember, and no way to ship a gateway build still claiming to be a
 * demo.
 */

import type { ReactNode } from 'react';

import { useStudioApi } from '../lib/api/context';

export function DemoModeBanner(): ReactNode {
  const api = useStudioApi();
  if (api.backend.kind !== 'demo') return null;

  return (
    <aside
      // `role="note"` rather than `alert`: it is standing context, not an event. An alert would
      // interrupt a screen reader on every route change to repeat something that has not changed.
      role="note"
      aria-label="데모 모드 안내"
      style={{
        border: '1px solid var(--line)',
        borderLeft: '4px solid var(--accent)',
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 16,
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <strong>데모 모드</strong> — 브라우저 안에서만 동작합니다. 화면의 규칙과 판정은 제품의 실제{' '}
      <code>domain/</code> 함수가 답하지만, <strong>음악은 생성되지 않습니다</strong>: 생성 요청은
      타이머로 진행되고, 재생·다운로드되는 소리는 자산 식별자로 합성한 톤입니다. 새로고침하면
      이 세션의 변경은 사라집니다.
    </aside>
  );
}
