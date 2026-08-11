import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../services/account/token-service';
import { createGatewayHarness, type GatewayHarness } from '../support/gateway-harness';

/**
 * 인증 플로 — 가입 → 로그인 → 토큰 갱신 → 만료 → 재로그인.
 *
 * **Validates: Requirements 1.1, 1.3, 1.4, 1.8**
 *
 * One journey, in order, with the clock moved rather than waited on. `auth-flow.test.ts` in
 * `test/integration/` asserts each of these as a contract; what this adds is that they compose —
 * in particular that a refresh performed *before* expiry produces a token that still works
 * *after* it, which is the property a user experiences as "I did not get logged out" and which
 * no single-step test can see.
 */

let harness: GatewayHarness;

const CREDENTIALS = { email: 'listener@studio.test', password: 'correct-horse-battery-staple' };

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

beforeEach(() => {
  harness = createGatewayHarness();
});

afterEach(async () => {
  await harness.close();
});

async function post(url: string, payload: Record<string, unknown>) {
  return await harness.app.inject({ method: 'POST', url: `/v1${url}`, payload });
}

async function whoami(accessToken: string) {
  return await harness.app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

describe('가입 → 로그인 → 갱신 → 만료 → 재로그인', () => {
  it('carries one account through the whole lifecycle', async () => {
    // Requirement 1.1 — 가입.
    const registered = await post('/auth/register', CREDENTIALS);
    expect(registered.statusCode).toBe(201);

    // Requirement 1.3 — 로그인, and the two lifetimes the clause fixes.
    const loggedIn = await post('/auth/login', CREDENTIALS);
    expect(loggedIn.statusCode).toBe(200);
    const first = loggedIn.json<Tokens & { accessTokenExpiresInSeconds: number }>();
    expect(first.accessTokenExpiresInSeconds).toBe(ACCESS_TOKEN_TTL_SECONDS);

    // The access token opens a protected route.
    expect((await whoami(first.accessToken)).statusCode).toBe(200);

    // Requirement 1.4 — 갱신, performed while the access token is still valid. This is the
    // ordinary client behaviour: refresh ahead of expiry rather than after a failure.
    harness.clock.advanceSeconds(ACCESS_TOKEN_TTL_SECONDS - 60);
    const refreshed = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json<Tokens>();

    // Requirement 1.8 — past the *first* token's expiry. The first is dead and the refreshed
    // one is alive, which is the whole point of having refreshed early.
    harness.clock.advanceSeconds(120);
    const expired = await whoami(first.accessToken);
    expect(expired.statusCode).toBe(401);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe('token_expired');
    expect((await whoami(second.accessToken)).statusCode).toBe(200);

    // Past the refresh token's own lifetime, nothing survives — and 재로그인 restores it all.
    harness.clock.advanceSeconds(REFRESH_TOKEN_TTL_SECONDS);
    expect((await post('/auth/refresh', { refreshToken: second.refreshToken })).statusCode).toBe(
      401,
    );

    const again = await post('/auth/login', CREDENTIALS);
    expect(again.statusCode).toBe(200);
    expect((await whoami(again.json<Tokens>().accessToken)).statusCode).toBe(200);
  });

  it('refuses the password it was not given, at every point in the flow', async () => {
    // The journey must not have a step that stops checking.
    await post('/auth/register', CREDENTIALS);

    const wrong = await post('/auth/login', { ...CREDENTIALS, password: 'not-the-password' });
    expect(wrong.statusCode).toBe(401);

    const loggedIn = await post('/auth/login', CREDENTIALS);
    const { refreshToken } = loggedIn.json<Tokens>();

    expect((await post('/auth/refresh', { refreshToken: `${refreshToken}x` })).statusCode).toBe(
      401,
    );
  });
});
