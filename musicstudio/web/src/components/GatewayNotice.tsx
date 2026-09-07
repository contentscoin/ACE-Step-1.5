/**
 * Says what a gateway build cannot do, and who is signed in.
 *
 * ### The counterpart to `DemoModeBanner`, and it exists for the same reason
 *
 * The demo banner prevents one misunderstanding: material that was synthesised presented where
 * generated material goes. A gateway build creates the mirror image. Five of the screens —
 * 탐색, 타임라인, 마스터링, and the sharing and effects panels — are backed by services whose
 * stores have no PostgreSQL adapter yet, so this build cannot answer for them. A user who finds
 * those screens failing one at a time learns it as a series of faults; said once, at the top, it
 * is a fact about the deployment.
 *
 * It is not an alert. Like the demo banner it is standing context, and a `role="alert"` would
 * interrupt a screen reader on every route change to repeat something that has not changed.
 */

import type { ReactNode } from 'react';

import { useStudioApi } from '../lib/api/context';
import { GATEWAY_UNAVAILABLE_CAPABILITIES } from '../lib/api/http-api';
import { useSessionTokens } from '../lib/api/session-context';

export function GatewayNotice(): ReactNode {
  const api = useStudioApi();
  const tokens = useSessionTokens();
  if (api.backend.kind !== 'gateway') return null;

  return (
    <aside
      role="note"
      aria-label="게이트웨이 연결 안내"
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
      <strong>게이트웨이 연결됨</strong>
      {tokens !== null && <> — {tokens.email}</>} — 생성·라이브러리·재생·다운로드는 실제
      서버에서 동작합니다. 이 배포에서 아직 제공하지 않는 기능:{' '}
      {GATEWAY_UNAVAILABLE_CAPABILITIES.join(', ')}.
    </aside>
  );
}
