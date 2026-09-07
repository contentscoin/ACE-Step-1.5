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

import { MainRegion, SkipLink } from './a11y/SkipLink';
import { DemoModeBanner } from './components/DemoModeBanner';
import { CapabilityUnavailable } from './components/CapabilityUnavailable';
import { GatewayNotice } from './components/GatewayNotice';
import { SignIn } from './components/SignIn';
import { hrefFor, useRoute } from './app/router';
import { EnterTransition } from './components/amicro/EnterTransition';
import { HoverLift } from './components/amicro/HoverLift';
import { TextReveal } from './components/amicro/TextReveal';
import { CueAnnouncer } from './components/sound/CueAnnouncer';
import { SoundSettingsPanel } from './components/sound/SoundSettingsPanel';
import { StudioApiProvider, useStudioApi } from './lib/api/context';
import { GatewaySessionProvider, useSessionTokens } from './lib/api/session-context';
import type { StudioApi } from './lib/api/port';
import type { Session } from './lib/api/session';
import { SoundProvider } from './sound/context';
import { MOTION_CLASSIFICATION_TABLE } from './motion/classification';
import { useReducedMotion } from './motion/reduced-motion';
import { OPEN_SOURCE_NOTICES } from './notices/open-source';
import { AssetPage } from './pages/AssetPage';
import { ExplorePage } from './pages/ExplorePage';
import { GeneratePage } from './pages/GeneratePage';
import { LibraryPage } from './pages/LibraryPage';
import { MasteringPage } from './pages/MasteringPage';
import { PublicPage } from './pages/PublicPage';
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

        <SoundSettingsPanel />

        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>오픈소스 고지 (Req 31.17, 32.20)</h2>
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

/**
 * The screens a gateway build cannot serve, and what each needs before it can.
 *
 * Rendering the screen anyway would leave it in its loading state forever: every call it makes
 * rejects, and an effect that made one does not render anything for a rejection. These three are
 * *wholly* unserved — every call they make is on the list in `http-api.ts` — so the screen is
 * replaced rather than partly disabled. `AssetPage` is the mixed case and handles its own panel.
 */
const UNSERVED_SCREENS: Readonly<Record<string, { capability: string; reason: string }>> = {
  explore: {
    capability: '탐색 피드',
    reason: '공개된 자산을 저장할 곳이 아직 없습니다.',
  },
  timeline: {
    capability: '타임라인',
    reason: '프로젝트를 저장할 곳이 아직 없습니다.',
  },
  mastering: {
    capability: '마스터링과 이펙트',
    reason: '버전과 이펙트 체인을 저장할 곳이 아직 없습니다.',
  },
};

function screenFor(name: string, parameter: string | null, unserved: boolean): ReactNode {
  const missing = UNSERVED_SCREENS[name];
  if (unserved && missing !== undefined) {
    return <CapabilityUnavailable capability={missing.capability} reason={missing.reason} />;
  }

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
    // Requirement 14.3's visitor route. Not in `NAV`: it is reached by holding a link, and a
    // nav entry would be a way to reach it without one.
    case 's':
      return <PublicPage token={parameter} />;
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

export interface AppProps {
  /** Omitted in tests and in the design-system build, where the demo backend is the subject. */
  readonly api?: StudioApi;
  /** The gateway session, or `null`/absent on a demo build. */
  readonly session?: Session | null;
  /** The gateway origin, for the sign-in panel. `null` on a demo build. */
  readonly gatewayUrl?: string | null;
}

export function App({ api, session = null, gatewayUrl = null }: AppProps): ReactNode {
  return (
    <StudioApiProvider {...(api === undefined ? {} : { api })}>
      <GatewaySessionProvider session={session}>
        <SoundProvider>
          <Shell gatewayUrl={gatewayUrl} />
        </SoundProvider>
      </GatewaySessionProvider>
    </StudioApiProvider>
  );
}

/**
 * The shell, inside the providers so it can read both.
 *
 * Separate from `App` for one reason: the gate below asks the api which backend it is and asks
 * the session whether there is a credential, and a component cannot read a context its own
 * element provides.
 */
function Shell({ gatewayUrl }: { readonly gatewayUrl: string | null }): ReactNode {
  const route = useRoute();
  const api = useStudioApi();
  const tokens = useSessionTokens();
  // A gateway build with no credential can render nothing truthfully: every screen's data is
  // behind Requirement 1's authentication. So the shell shows the panel in place of the screen
  // — the navigation stays, because the nav is not data.
  const needsSignIn = api.backend.kind === 'gateway' && tokens === null && gatewayUrl !== null;

  return (
        <main style={{ maxWidth: 980, margin: '0 auto', padding: 24, lineHeight: 1.6 }}>
          {/* First in the DOM, so it is the first Tab stop — see `a11y/SkipLink.tsx`. */}
          <SkipLink />
          {/*
            After the skip link and before everything else. The skip link has to stay the first
            Tab stop (31.13), and the banner has to be read before the screen it qualifies —
            putting it below the navigation would let a visitor reach the generation form without
            passing the sentence that says nothing will be generated.
          */}
          <DemoModeBanner />
          {/* The mirror image, for a gateway build: what this deployment cannot do. */}
          <GatewayNotice />
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

          {/* Keyed by route so a screen remounts — and reloads — when the parameter changes.
              `MainRegion` moves focus here on every change, so a keyboard user lands on the new
              screen rather than in the nav they just left. */}
          <MainRegion routeKey={`${route.name}/${route.parameter ?? ''}`}>
            <div key={`${route.name}/${route.parameter ?? ''}`}>
              {needsSignIn ? (
                <SignIn baseUrl={gatewayUrl} />
              ) : (
                screenFor(route.name, route.parameter, api.backend.kind === 'gateway')
              )}
            </div>
          </MainRegion>
          {/* Requirement 32.15: every played cue's sentence, within the same task it fired in. */}
          <CueAnnouncer />
        </main>
  );
}
