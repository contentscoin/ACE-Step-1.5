/**
 * What the shell does when a gateway is wired (slice S7).
 *
 * The roadmap's S7 row says the demo banner disappears *by itself*. That is the assertion here,
 * and it is worth being literal about: nothing in the tree is told which backend was built, and
 * no test sets a flag. `api.backend` is the backend answering for itself, so a build that wired a
 * gateway cannot still be claiming to be a demo — and the case below would fail if anyone
 * introduced a second switch for it.
 *
 * The rest is the honesty counterpart. A gateway build reaches five surfaces it cannot answer
 * for, and the failure to avoid is a user meeting them one at a time as faults.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { App } from '../../src/App';
import { createDemoApi } from '../../src/lib/api/demo-api';
import { createHttpApi } from '../../src/lib/api/http-api';
import { createSession, type SessionTokens } from '../../src/lib/api/session';
import { configuredGatewayUrl, createStudioBackend } from '../../src/lib/api/create';

afterEach(() => {
  cleanup();
});

const BASE_URL = 'http://gateway.test';

const TOKENS: SessionTokens = {
  accountId: 'account-1',
  email: 'composer@studio.test',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
};

/** A `fetch` that answers every call with an empty listing, so screens settle. */
const quietFetch = (async () =>
  new Response(JSON.stringify({ assets: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof globalThis.fetch;

function gatewayApp(initial: SessionTokens | null) {
  const session = createSession({ baseUrl: BASE_URL, fetchImpl: quietFetch, initial });
  const api = createHttpApi({ baseUrl: BASE_URL, session, fetchImpl: quietFetch });
  return <App api={api} session={session} gatewayUrl={BASE_URL} />;
}

describe('the demo banner and its gateway counterpart', () => {
  it('shows the demo banner when the demo backend answers', () => {
    render(<App api={createDemoApi()} />);

    expect(screen.getByLabelText('데모 모드 안내')).toBeTruthy();
    expect(screen.queryByLabelText('게이트웨이 연결 안내')).toBeNull();
  });

  it('drops the demo banner when a gateway answers, with nothing telling it to', () => {
    render(gatewayApp(TOKENS));

    expect(screen.queryByLabelText('데모 모드 안내')).toBeNull();
    const notice = screen.getByLabelText('게이트웨이 연결 안내');
    // The account, so a shared machine cannot leave someone generating as the last person.
    expect(notice.textContent).toContain('composer@studio.test');
    // And what this deployment cannot do, said once rather than discovered five times.
    expect(notice.textContent).toContain('탐색 피드');
    expect(notice.textContent).toContain('타임라인');
  });
});

describe('a gateway build with no credential', () => {
  it('asks for one instead of rendering a screen that cannot load', () => {
    render(gatewayApp(null));

    expect(screen.getByRole('heading', { name: '로그인' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    // Registration is beside it: a person arriving at a fresh deployment has no account yet.
    expect(screen.getByRole('button', { name: '가입' })).toBeTruthy();
    // The generation form is not rendered behind it — every call it makes needs the credential.
    expect(screen.queryByRole('button', { name: '생성 요청' })).toBeNull();
  });

  it('renders the screen once there is one', () => {
    render(gatewayApp(TOKENS));

    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull();
  });
});

describe('the screens a gateway build cannot serve', () => {
  it.each([
    ['#/explore', '탐색 피드'],
    ['#/timeline', '타임라인'],
    ['#/mastering', '마스터링과 이펙트'],
  ])('says so on %s rather than loading forever', (hash, capability) => {
    globalThis.location.hash = hash;
    render(gatewayApp(TOKENS));

    expect(screen.getByLabelText(`${capability} 사용 불가 안내`)).toBeTruthy();
  });

  it('still serves the screens it can', () => {
    globalThis.location.hash = '#/library';
    render(gatewayApp(TOKENS));

    // The library is one of the four that work, so it is *not* replaced by a notice.
    expect(screen.queryByLabelText('탐색 피드 사용 불가 안내')).toBeNull();
  });
});

describe('which backend a build gets', () => {
  it('is the demo unless an origin is configured', () => {
    expect(configuredGatewayUrl({})).toBeNull();
    expect(configuredGatewayUrl({ VITE_MUSICSTUDIO_API_URL: '   ' })).toBeNull();
    expect(createStudioBackend({}).api.backend.kind).toBe('demo');
    expect(createStudioBackend({}).session).toBeNull();
  });

  it('is the gateway when one is, and the session comes with it', () => {
    const backend = createStudioBackend({ VITE_MUSICSTUDIO_API_URL: `${BASE_URL}/` });

    expect(backend.api.backend.kind).toBe('gateway');
    expect(backend.session).not.toBeNull();
    // Trailing slash trimmed once, at the edge, so no call site has to think about it.
    expect(backend.gatewayUrl).toBe(BASE_URL);
  });
});
