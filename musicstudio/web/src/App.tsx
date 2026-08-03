/**
 * The shell, and a demonstration surface for Requirement 31.1's four categories.
 *
 * Task 7.1 is the design system, not the product screens — those are 7.3. What this file has to do
 * is make the four categories *present in the build artefact*, which is the second half of
 * Requirement 31.15: an offline build must produce a screen with the four categories on it, so a
 * scaffold that imported nothing would satisfy the first half and fail the second.
 *
 * So this is deliberately a demonstration rather than a home page: each of the four components is
 * rendered, and the progress display shows the loading category doing the job Requirement 31.6
 * gives it. 7.3 replaces the content and keeps the imports.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

import { EnterTransition } from './components/amicro/EnterTransition';
import { HoverLift } from './components/amicro/HoverLift';
import { TextReveal } from './components/amicro/TextReveal';
import { GenerationProgress } from './components/generation/GenerationProgress';
import type { ProgressState } from './components/generation/progress';
import { MOTION_CLASSIFICATION_TABLE } from './motion/classification';
import { useReducedMotion } from './motion/reduced-motion';
import { OPEN_SOURCE_NOTICES } from './notices/open-source';

export function App(): ReactNode {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<ProgressState['phase']>('queued');

  const read = useCallback(
    (): ProgressState =>
      phase === 'queued'
        ? { phase: 'queued', percent: null, queuePosition: 3 }
        : { phase: 'running', percent: 42, queuePosition: null },
    [phase],
  );

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24, lineHeight: 1.6 }}>
      <EnterTransition>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>MusicStudio</h1>
        <p style={{ opacity: 0.7 }}>
          <TextReveal text="멀티모달 AI 오디오 스튜디오 — 디자인 시스템 스캐폴드" />
        </p>
      </EnterTransition>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>생성 진행 상태 (Req 31.6, 31.7)</h2>
        <GenerationProgress read={read} />
        <HoverLift>
          <button
            type="button"
            onClick={() => {
              setPhase((current) => (current === 'queued' ? 'running' : 'queued'));
            }}
            style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, cursor: 'pointer' }}
          >
            {phase === 'queued' ? '진행 상태로 전환' : '대기 상태로 전환'}
          </button>
        </HoverLift>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Motion_Classification_Table (Req 31.18)</h2>
        <p style={{ opacity: 0.7 }}>
          감소된 모션: <strong>{reduced ? '켜짐' : '꺼짐'}</strong>
        </p>
        <ul>
          {MOTION_CLASSIFICATION_TABLE.map((entry) => (
            <li key={entry.component}>
              <code>{entry.component}</code> — {entry.category} / {entry.purpose}
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>오픈소스 고지 (Req 31.17)</h2>
        <ul>
          {OPEN_SOURCE_NOTICES.map((notice) => (
            <li key={notice.name}>
              {notice.name} {notice.version} — {notice.license}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
