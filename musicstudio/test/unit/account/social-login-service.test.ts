import { describe, expect, it } from 'vitest';

import { createAccountService } from '../../../services/account/account-service';
import { createRedisLoginAttemptStore } from '../../../services/account/adapters/redis-login-attempt-store';
import { createRedisSessionStore } from '../../../services/account/adapters/redis-session-store';
import { createFakeRedis } from '../../support/fake-redis';
import { createInMemoryAccountRepository } from '../../support/in-memory-account-repository';
import { createMutableClock } from '../../support/mutable-clock';
import { createRecordingEmailSender } from '../../support/recording-email-sender';
import { createStubOAuthProvider } from '../../support/stub-oauth-provider';

const SECRET = 'unit-test-secret-of-at-least-32-characters';

function createService(providerEmail: string) {
  const clock = createMutableClock();
  const redis = createFakeRedis(clock);
  const repository = createInMemoryAccountRepository();
  const google = createStubOAuthProvider('google', {
    subject: 'google-subject-1',
    email: providerEmail,
    emailVerified: true,
  });

  const service = createAccountService({
    repository,
    sessionStore: createRedisSessionStore({ commands: redis, clock }),
    loginAttemptStore: createRedisLoginAttemptStore({ commands: redis }),
    emailSender: createRecordingEmailSender(),
    jwtSecret: SECRET,
    publicBaseUrl: 'https://studio.test',
    oauthProviders: [google],
    clock,
  });

  return { clock, repository, service };
}

const callback = {
  code: 'authorization-code-1',
  redirectUri: 'https://studio.test/callback',
  state: 'state-1',
  expectedState: 'state-1',
  provider: 'google',
};

/** Requirement 1.7 — account resolution after a successful code exchange. */
describe('social login account resolution', () => {
  it('creates a password-less account on first authorization', async () => {
    const { repository, service } = createService('new@example.com');

    const result = await service.completeAuthorization(callback);

    expect(result.accountCreated).toBe(true);
    const account = await repository.findById(result.accountId);
    expect(account?.passwordHash).toBeNull();
    expect(account?.emailVerifiedAt).not.toBeNull();
    expect(account?.socialIdentities).toEqual([
      { provider: 'google', subject: 'google-subject-1' },
    ]);
  });

  it('reuses the same account on a second authorization', async () => {
    const { repository, service } = createService('returning@example.com');

    const first = await service.completeAuthorization(callback);
    const second = await service.completeAuthorization(callback);

    expect(second.accountId).toBe(first.accountId);
    expect(second.accountCreated).toBe(false);
    expect(repository.size).toBe(1);
  });

  it('links the provider identity to an existing password account with the same address', async () => {
    const { repository, service } = createService('creator@example.com');
    const registered = await service.register({
      email: 'creator@example.com',
      password: 'correct horse battery',
    });

    const result = await service.completeAuthorization(callback);

    expect(result.accountId).toBe(registered.accountId);
    expect(repository.size).toBe(1);
    const account = await repository.findById(registered.accountId);
    expect(account?.passwordHash).not.toBeNull();
    expect(account?.socialIdentities).toHaveLength(1);
  });

  it('issues a session whose access token authenticates immediately', async () => {
    const { service } = createService('new@example.com');

    const result = await service.completeAuthorization(callback);
    const authenticated = await service.authenticateAccessToken(result.tokens.accessToken);

    expect(authenticated.accountId).toBe(result.accountId);
    expect(authenticated.emailVerified).toBe(true);
  });

  it('reports an unconfigured provider rather than falling back to another one', async () => {
    const { service } = createService('new@example.com');

    await expect(
      service.beginAuthorization({ provider: 'apple', redirectUri: 'https://studio.test/cb' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'social_login_not_configured' });
    expect(service.isSocialProviderConfigured('apple')).toBe(false);
    expect(service.configuredSocialProviderIds()).toEqual(['google']);
  });
});
