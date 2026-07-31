import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOGIN_LOCK_DURATION_SECONDS,
  MAX_CONSECUTIVE_LOGIN_FAILURES,
} from '../../services/account/login-throttle';
import { createGatewayHarness, type GatewayHarness } from '../support/gateway-harness';
import { createStubOAuthProvider } from '../support/stub-oauth-provider';

const EMAIL = 'creator@example.com';
const PASSWORD = 'correct horse battery';

/** Requirements 1.2, 1.4, 1.5, 1.7 — the rejection paths of the auth surface. */
describe('authentication rejections', () => {
  let harness: GatewayHarness;

  beforeEach(async () => {
    harness = createGatewayHarness();
    await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: EMAIL, password: PASSWORD },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const login = (password: string) =>
    harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password },
    });

  it('answers 409 with a duplicate reason for an already registered email', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      // Casing differs; the address is still the same account (Requirement 1.2).
      payload: { email: 'CREATOR@example.com', password: 'another password' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'email_already_registered',
      email: EMAIL,
    });
    expect(harness.repository.size).toBe(1);
  });

  it('answers 401 for a wrong password and 429 once five failures accumulate', async () => {
    // Requirement 1.4 — every mismatch is 401 and advances the counter.
    for (let attempt = 1; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES; attempt += 1) {
      const response = await login('wrong password');
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('invalid_credentials');
    }

    // The fifth failure is still 401 but trips the lock.
    expect((await login('wrong password')).statusCode).toBe(401);

    // Requirement 1.5 — login is refused while locked, even with the right password.
    const locked = await login(PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('login_temporarily_locked');
    expect(Number(locked.headers['retry-after'])).toBe(LOGIN_LOCK_DURATION_SECONDS);

    // Still locked one second before the window closes.
    harness.clock.advanceSeconds(LOGIN_LOCK_DURATION_SECONDS - 1);
    expect((await login(PASSWORD)).statusCode).toBe(429);

    // ...and allowed again once the 15 minutes have elapsed.
    harness.clock.advanceSeconds(1);
    expect((await login(PASSWORD)).statusCode).toBe(200);
  });

  it('does not lock an account whose failure streak was broken by a success', async () => {
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES - 1; attempt += 1) {
      expect((await login('wrong password')).statusCode).toBe(401);
    }
    expect((await login(PASSWORD)).statusCode).toBe(200);

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES - 1; attempt += 1) {
      expect((await login('wrong password')).statusCode).toBe(401);
    }
    expect((await login(PASSWORD)).statusCode).toBe(200);
  });

  it('reports 401 rather than 404 for an unknown address', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('invalid_credentials');
  });

  it('rejects a malformed signup before touching the account layer', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
    expect(harness.repository.size).toBe(1);
  });
});

/** Requirement 1.7 — the `WHERE 소셜 로그인 제공자가 설정된 경우` guard. */
describe('social login configuration gate', () => {
  it('answers 404 when no provider is configured', async () => {
    const harness = createGatewayHarness();
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/auth/social/google/authorize?redirectUri=https://studio.test/callback',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatchObject({
        code: 'social_login_not_configured',
        provider: 'google',
      });
    } finally {
      await harness.close();
    }
  });

  it('runs the authorization code flow when a provider is configured', async () => {
    const google = createStubOAuthProvider('google', {
      subject: 'google-subject-1',
      email: 'social@example.com',
      emailVerified: true,
    });
    const harness = createGatewayHarness({ oauthProviders: [google] });

    try {
      const started = await harness.app.inject({
        method: 'GET',
        url: '/v1/auth/social/google/authorize?redirectUri=https://studio.test/callback',
      });
      expect(started.statusCode).toBe(200);
      const { state, authorizationUrl } = started.json();
      expect(authorizationUrl).toContain('response_type=code');

      const completed = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/social/google/callback',
        payload: {
          code: 'authorization-code-1',
          state,
          expectedState: state,
          redirectUri: 'https://studio.test/callback',
        },
      });

      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({
        email: 'social@example.com',
        accountCreated: true,
      });
      expect(google.exchangedCodes).toEqual(['authorization-code-1']);

      // The issued access token authenticates a protected call.
      const me = await harness.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${completed.json().accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().emailVerified).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('rejects a callback whose state does not match the issued value', async () => {
    const google = createStubOAuthProvider('google', {
      subject: 'google-subject-2',
      email: 'social@example.com',
      emailVerified: true,
    });
    const harness = createGatewayHarness({ oauthProviders: [google] });

    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/social/google/callback',
        payload: {
          code: 'authorization-code-2',
          state: 'attacker-state',
          expectedState: 'issued-state',
          redirectUri: 'https://studio.test/callback',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('social_login_state_mismatch');
      expect(google.exchangedCodes).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
