/**
 * What a screen shows when this build's backend cannot answer for it.
 *
 * A gateway build reaches five surfaces whose services exist and whose stores do not — sharing,
 * the explore feed, the timeline, effects and mastering (`http-api.ts` says which and why). The
 * screens behind them would otherwise sit in their loading state forever: the calls reject, the
 * effects that made them do not render anything for a rejection, and a spinner that never
 * resolves is the least legible way to say "not here".
 *
 * So they say it. The wording names the capability and the reason, because "일시적인 오류"
 * would send someone to reload a page that will never load, and the reason is not an error: the
 * work is listed in `docs/ROADMAP.md` §4.5 and has not been done.
 */

import type { ReactNode } from 'react';

import { meta, panel } from '../styles/ui';

export interface CapabilityUnavailableProps {
  readonly capability: string;
  /** What has to exist for it to work, in the user's terms rather than the schema's. */
  readonly reason?: string;
}

export function CapabilityUnavailable({
  capability,
  reason,
}: CapabilityUnavailableProps): ReactNode {
  return (
    <div style={panel} role="note" aria-label={`${capability} 사용 불가 안내`}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{capability}은(는) 아직 제공되지 않습니다</h2>
      <p style={meta}>
        이 빌드는 게이트웨이에 연결되어 있고, 게이트웨이에 {capability} 기능이 아직 없습니다.
        {reason !== undefined && <> {reason}</>} 생성·라이브러리·재생·다운로드는 정상적으로
        동작합니다.
      </p>
    </div>
  );
}
