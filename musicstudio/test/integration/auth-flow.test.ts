import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../services/account/token-service';
import { parsePasswordHashCost } from '../../services/account/password-hasher';
import { MINIMUM_PASSWORD_HASH_COST } from '../../services/account/password-hasher';
import { createGatewayHarness, type GatewayHarness } from '../support/gateway-harness';

/**
 * Task 1.2 acceptance criterion: signup -> login -> token issue -> protected
 * API call succeeds end to end, and an expired token yields 401.
 *
 * Driven through Fastify's `inject()`, so no port is bound and no network is
 * touched, and through the fake clock, so token expiry is observed rather than
 * waited for.
 */
const CREDENTIALS = { email: 'Creator@Example.COM', password: 'correct horse battery' };

describe('authentication end-to-end flow', () => {
  let harness: GatewayHarness;

  beforeEach(() => {
    harness = createGatewayHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('registers, logs in, calls a protected route, then rejects the expired token', async () => {
    // Requirement 1.1 — account created and a verification link sent.
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: CREDENTIALS,
    });

    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toMatchObject({
      email: 'creator@example.com',
      emailVerificationSent: true,
    });
    expect(harness.emails.sent).toHaveLength(1);
    expect(harness.emails.sent[0]?.verificationLink).toContain('https://studio.test/verify-email');

    // Requirement 1.6 — only a bcrypt hash with cost >= 12 is stored.
    const stored = await harness.repository.findByEmail('creator@example.com');
    expect(stored?.passwordHash).not.toBe(CREDENTIALS.password);
    expect(parsePasswordHashCost(stored?.passwordHash ?? '')).toBeGreaterThanOrEqual(
      MINIMUM_PASSWORD_HASH_COST,
    );

    // Requirement 1.3 — 24 hour access token, 30 day refresh token.
    const loggedIn = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: CREDENTIALS,
    });

    expect(loggedIn.statusCode).toBe(200);
    const tokens = loggedIn.json();
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.accessTokenExpiresInSeconds).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(tokens.refreshTokenExpiresInSeconds).toBe(REFRESH_TOKEN_TTL_SECONDS);

    // Protected call succeeds with the freshly issued access token.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      accountId: tokens.accountId,
      email: 'creator@example.com',
      emailVerified: false,
    });

    // Requirement 1.8 — one second past the 24 hour lifetime, 401 + reason code.
    harness.clock.advanceSeconds(ACCESS_TOKEN_TTL_SECONDS + 1);
    const expired = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('token_expired');
    expect(expired.headers['www-authenticate']).toBe('Bearer error="token_expired"');

    // The 30 day refresh token still works and restores access.
    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });

    expect(refreshed.statusCode).toBe(200);
    const renewed = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
    });
    expect(renewed.statusCode).toBe(200);
  });

  it('completes the email verification link from the signup mail', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
    const token = harness.emails.lastLinkToken();
    expect(token).not.toBeNull();

    const verified = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().emailVerified).toBe(true);

    const loggedIn = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: CREDENTIALS,
    });
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${loggedIn.json().accessToken}` },
    });

    expect(me.json().emailVerified).toBe(true);
  });

  it('keeps the session in the Redis cache and drops it on logout', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
    const tokens = (
      await harness.app.inject({ method: 'POST', url: '/v1/auth/login', payload: CREDENTIALS })
    ).json();

    const sessionKeys = harness.redis.liveKeys().filter((key) => key.includes(':session:'));
    expect(sessionKeys).toHaveLength(1);
    // The cache entry expires with the refresh token it belongs to.
    expect(harness.redis.ttlOf(sessionKeys[0] ?? '')).toBe(REFRESH_TOKEN_TTL_SECONDS);

    const loggedOut = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(loggedOut.statusCode).toBe(204);
    expect(harness.redis.liveKeys().filter((key) => key.includes(':session:'))).toHaveLength(0);

    // Revocation takes effect immediately, well before the token's own expiry.
    const afterLogout = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json().error.code).toBe('session_not_found');
  });

  it('rejects a protected call with no Bearer token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('authorization_header_missing');
  });
});
