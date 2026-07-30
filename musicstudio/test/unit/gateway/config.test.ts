import { describe, expect, it } from 'vitest';

import { loadGatewayConfig, type Environment } from '../../../api/gateway/config';
import { buildSocialProviders } from '../../../api/gateway/social-providers';

const REQUIRED: Environment = {
  MUSICSTUDIO_JWT_SECRET: 'gateway-secret-of-at-least-32-characters',
  MUSICSTUDIO_PUBLIC_BASE_URL: 'https://studio.example.com',
  MUSICSTUDIO_REDIS_URL: 'redis://localhost:6379',
};

describe('gateway configuration', () => {
  it('loads the required settings and defaults the bcrypt cost to 12', () => {
    const config = loadGatewayConfig(REQUIRED);

    expect(config.passwordHashCost).toBe(12);
    expect(config.google).toBeNull();
    expect(config.apple).toBeNull();
  });

  it.each([
    'MUSICSTUDIO_JWT_SECRET',
    'MUSICSTUDIO_PUBLIC_BASE_URL',
    'MUSICSTUDIO_REDIS_URL',
  ])('fails fast when %s is missing', (name) => {
    const env = { ...REQUIRED, [name]: undefined };

    expect(() => loadGatewayConfig(env)).toThrow(name);
  });

  it('rejects a signing key that is too short', () => {
    expect(() => loadGatewayConfig({ ...REQUIRED, MUSICSTUDIO_JWT_SECRET: 'short' })).toThrow(
      'MUSICSTUDIO_JWT_SECRET',
    );
  });

  // Requirement 1.6: configuration cannot weaken the work factor below 12.
  it('rejects a bcrypt cost below the required minimum', () => {
    expect(() =>
      loadGatewayConfig({ ...REQUIRED, MUSICSTUDIO_PASSWORD_HASH_COST: '10' }),
    ).toThrow('MUSICSTUDIO_PASSWORD_HASH_COST');
  });

  it('rejects a client id supplied without its secret', () => {
    expect(() =>
      loadGatewayConfig({ ...REQUIRED, MUSICSTUDIO_OAUTH_GOOGLE_CLIENT_ID: 'client-id' }),
    ).toThrow('MUSICSTUDIO_OAUTH_GOOGLE_CLIENT_SECRET');
  });
});

/** Requirement 1.7 — providers exist only where configured. */
describe('social provider composition', () => {
  it('registers no provider when none is configured', () => {
    expect(buildSocialProviders(loadGatewayConfig(REQUIRED))).toEqual([]);
  });

  it('registers exactly the configured providers', () => {
    const config = loadGatewayConfig({
      ...REQUIRED,
      MUSICSTUDIO_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      MUSICSTUDIO_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
    });

    expect(buildSocialProviders(config).map((provider) => provider.id)).toEqual(['google']);
  });

  it('sends the configured client id in the authorization URL', () => {
    const config = loadGatewayConfig({
      ...REQUIRED,
      MUSICSTUDIO_OAUTH_APPLE_CLIENT_ID: 'apple-client-id',
      MUSICSTUDIO_OAUTH_APPLE_CLIENT_SECRET: 'apple-client-secret',
    });

    const [apple] = buildSocialProviders(config);
    const url = new URL(
      apple?.buildAuthorizationUrl({
        state: 's',
        nonce: 'n',
        redirectUri: 'https://studio.example.com/cb',
      }) ?? '',
    );

    expect(url.host).toBe('appleid.apple.com');
    expect(url.searchParams.get('client_id')).toBe('apple-client-id');
    expect(url.searchParams.get('response_mode')).toBe('form_post');
  });
});
