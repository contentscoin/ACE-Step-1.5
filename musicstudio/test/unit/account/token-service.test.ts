import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createJwtTokenService,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../../services/account/token-service';
import { createMutableClock } from '../../support/mutable-clock';

const SECRET = 'unit-test-secret-of-at-least-32-characters';

function createService() {
  const clock = createMutableClock();
  return { clock, tokens: createJwtTokenService({ secret: SECRET, clock }) };
}

/** Requirements 1.3 and 1.8. */
describe('JWT token service', () => {
  it('rejects a signing key that is too short to be safe', () => {
    expect(() => createJwtTokenService({ secret: 'too-short' })).toThrow(RangeError);
  });

  it('issues a 24 hour access token and a 30 day refresh token', async () => {
    const { clock, tokens } = createService();

    const pair = await tokens.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    const issuedAtMs = clock.now().getTime();
    expect((pair.accessTokenExpiresAt.getTime() - issuedAtMs) / 1000).toBe(
      ACCESS_TOKEN_TTL_SECONDS,
    );
    expect((pair.refreshTokenExpiresAt.getTime() - issuedAtMs) / 1000).toBe(
      REFRESH_TOKEN_TTL_SECONDS,
    );
  });

  it('recovers the account and session from a valid access token', async () => {
    const { tokens } = createService();
    const pair = await tokens.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    const claims = await tokens.verify(pair.accessToken, 'access');

    expect(claims).toMatchObject({
      accountId: 'account-1',
      sessionId: 'session-1',
      kind: 'access',
    });
  });

  it('accepts the access token up to its expiry and reports expiry one second later', async () => {
    const { clock, tokens } = createService();
    const pair = await tokens.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    clock.advanceSeconds(ACCESS_TOKEN_TTL_SECONDS - 1);
    await expect(tokens.verify(pair.accessToken, 'access')).resolves.toMatchObject({
      accountId: 'account-1',
    });

    clock.advanceSeconds(2);
    await expect(tokens.verify(pair.accessToken, 'access')).rejects.toMatchObject({
      statusCode: 401,
      code: 'token_expired',
    });
  });

  it('keeps the refresh token valid long after the access token expires', async () => {
    const { clock, tokens } = createService();
    const pair = await tokens.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    clock.advanceSeconds(ACCESS_TOKEN_TTL_SECONDS + 1);

    await expect(tokens.verify(pair.refreshToken, 'refresh')).resolves.toMatchObject({
      kind: 'refresh',
    });
  });

  it('refuses to use a refresh token where an access token is expected', async () => {
    const { tokens } = createService();
    const pair = await tokens.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    await expect(tokens.verify(pair.refreshToken, 'access')).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('refuses a token signed with a different key', async () => {
    const { tokens } = createService();
    const foreign = createJwtTokenService({
      secret: 'a-different-secret-of-at-least-32-characters',
      clock: createMutableClock(),
    });
    const pair = await foreign.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    await expect(tokens.verify(pair.accessToken, 'access')).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('refuses a tampered token', async () => {
    const { tokens } = createService();
    const pair = await tokens.issuePair({ accountId: 'account-1', sessionId: 'session-1' });

    await expect(tokens.verify(`${pair.accessToken}x`, 'access')).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });
});
