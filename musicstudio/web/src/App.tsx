/**
 * The shell: navigation, the route table, and the design-system page.
 *
 * ### One route table, and every screen's parameters come from it
 *
 * A screen takes what it needs as props (`assetId`) and never reads the location, so it renders in
 * a test with a literal id and in the app with one from the hash. That is also what keeps
 * `app/router.tsx` replaceable — see its header.
 *
 * ### The design-system page did not go away
 *
 * Requirement 31.15 asks that an offline build produce a screen carrying the four motion
 * categories, and 31.18 that the classification table be published. Task 7.1 put both on the home
 * page because there was nothing else; now they live at `#/system`, and the four categories are in
 * the bundle several times over because the product screens use them. Keeping the page is what
 * makes 31.18's table something a reader can *find* rather than something only the source has.
 */

import type { ReactNode } from 'react';

import { hrefFor, useRoute } from './app/router';
import { EnterTransition } from './components/amicro/EnterTransition';
import { HoverLift } from './components/amicro/HoverLift';
import { TextReveal } from './components/amicro/TextReveal';
import { StudioApiProvider } from './lib/api/context';
import { MOTION_CLASSIFICATION_TABLE } from './motion/classification';
import { useReducedMotion } from './motion/reduced-motion';
import { OPEN_SOURCE_NOTICES } from './notices/open-source';
import { AssetPage } from './pages/AssetPage';
import { ExplorePage } from './pages/ExplorePage';
import { GeneratePage } from './pages/GeneratePage';
import { LibraryPage } from './pages/LibraryPage';
import { MasteringPage } from './pages/MasteringPage';
import { TimelinePage } from './pages/TimelinePage';
import { chip, meta, panel, row } from './styles/ui';

/** The asset the mastering and asset screens open when the hash names none. */
const DEFAULT_ASSET_ID = 'asset-night-drive';

interface NavItem {
  readonly name: string;
  readonly title: string;
}

/** The five product flows of task 7.3, plus the design-system page. */
const NAV: readonly NavItem[] = [
  { name: 'generate', title: '생성' },
  { name: 'library', title: '라이브러리' },
  { name: 'timeline', title: '타임라인' },
  { name: 'mastering', title: '마스터링' },
  { name: 'explore', title: '탐색' },
  { name: 'system', title: '디자인 시스템' },
];

function SystemPage(): ReactNode {
  const reduced = useReducedMotion();

  return (
    <EnterTransition>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Motion_Classification_Table (Req 31.18)</h2>
          <p style={meta}>
            감소된 모션: <strong>{reduced ? '켜짐' : '꺼짐'}</strong> — 이 설정에서는 모든 전환이
            즉시 완료됩니다 (Req 31.14).
          </p>
          <ul>
            {MOTION_CLASSIFICATION_TABLE.map((entry) => (
              <li key={entry.component}>
                <code>{entry.component}</code> — {entry.category} / {entry.purpose}
              </li>
            ))}
          </ul>
        </div>

        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>오픈소스 고지 (Req 31.17)</h2>
          <ul>
            {OPEN_SOURCE_NOTICES.map((notice) => (
              <li key={notice.name}>
                {notice.name} {notice.version} — {notice.license}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </EnterTransition>
  );
}

function screenFor(name: string, parameter: string | null): ReactNode {
  switch (name) {
    case 'library':
      return <LibraryPage />;
    case 'asset':
      return <AssetPage assetId={parameter ?? DEFAULT_ASSET_ID} />;
    case 'timeline':
      return <TimelinePage />;
    case 'mastering':
      return <MasteringPage assetId={parameter ?? DEFAULT_ASSET_ID} />;
    case 'explore':
      return <ExplorePage />;
    case 'system':
      return <SystemPage />;
    case 'generate':
      return <GeneratePage />;
    default:
      // An unknown hash shows the default screen rather than an error page: the hash is
      // user-editable, and a typo should not look like a fault in the app.
      return <GeneratePage />;
  }
}

export function App(): ReactNode {
  const route = useRoute();

  return (
    <StudioApiProvider>
      <main style={{ maxWidth: 980, margin: '0 auto', padding: 24, lineHeight: 1.6 }}>
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
            <TextReveal text="MusicStudio" />
          </h1>
          <p style={meta}>멀티모달 AI 오디오 스튜디오</p>
          <nav style={{ ...row, flexWrap: 'wrap', marginTop: 12 }} aria-label="주요 화면">
            {NAV.map((item) => {
              const current =
                item.name === route.name ||
                // The asset detail screen is reached from the library and belongs to it.
                (item.name === 'library' && route.name === 'asset');
              return (
                <HoverLift key={item.name}>
                  <a
                    href={
                      item.name === 'mastering'
                        ? hrefFor(item.name, DEFAULT_ASSET_ID)
                        : hrefFor(item.name)
                    }
                    aria-current={current ? 'page' : undefined}
                    style={{
                      ...chip,
                      textDecoration: 'none',
                      color: 'inherit',
                      padding: '6px 12px',
                      fontSize: 14,
                      opacity: current ? 1 : 0.7,
                      borderColor: current ? 'var(--accent)' : 'var(--line)',
                    }}
                  >
                    {item.title}
                  </a>
                </HoverLift>
              );
            })}
          </nav>
        </header>

        {/* Keyed by route so a screen remounts — and reloads — when the parameter changes. */}
        <div key={`${route.name}/${route.parameter ?? ''}`}>
          {screenFor(route.name, route.parameter)}
        </div>
      </main>
    </StudioApiProvider>
  );
}
