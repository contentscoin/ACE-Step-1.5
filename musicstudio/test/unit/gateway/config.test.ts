import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DSP_URL,
  DEFAULT_ENGINE_DAILY_QUOTA,
  DEFAULT_ENGINE_URL,
  DEFAULT_OBJECT_STORE_DIRECTORY,
  loadGatewayConfig,
  type Environment,
} from '../../../api/gateway/config';
import { buildSocialProviders } from '../../../api/gateway/social-providers';

const REQUIRED: Environment = {
  MUSICSTUDIO_JWT_SECRET: 'gateway-secret-of-at-least-32-characters',
  MUSICSTUDIO_PUBLIC_BASE_URL: 'https://studio.example.com',
  MUSICSTUDIO_REDIS_URL: 'redis://localhost:6379',
  MUSICSTUDIO_DATABASE_URL: 'postgresql://postgres@localhost:5432/musicstudio',
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
    'MUSICSTUDIO_DATABASE_URL',
  ])('fails fast when %s is missing', (name) => {
    const env = { ...REQUIRED, [name]: undefined };

    expect(() => loadGatewayConfig(env)).toThrow(name);
  });

  // Slice S5: a first `npm start` needs the two stores and a secret, nothing else — the
  // engine, the sidecar and the object store default to where their own start scripts put them.
  it('defaults the engine, the DSP sidecar and the object store to their local addresses', () => {
    const config = loadGatewayConfig(REQUIRED);

    expect(config.engine.baseUrl).toBe(DEFAULT_ENGINE_URL);
    expect(config.engine.apiToken).toBeNull();
    expect(config.engine.executionLocation).toBe('local');
    expect(config.engine.dailyQuota).toEqual(DEFAULT_ENGINE_DAILY_QUOTA);
    expect(config.dspUrl).toBe(DEFAULT_DSP_URL);
    expect(config.objectStoreDirectory).toBe(DEFAULT_OBJECT_STORE_DIRECTORY);
    expect(config.migrateOnStart).toBe(false);
  });

  it('reads the engine settings when supplied', () => {
    const config = loadGatewayConfig({
      ...REQUIRED,
      MUSICSTUDIO_ENGINE_URL: 'http://gpu-box:8001/',
      MUSICSTUDIO_ENGINE_API_TOKEN: 'engine-token',
      MUSICSTUDIO_ENGINE_EXECUTION_LOCATION: 'remote',
      MUSICSTUDIO_ENGINE_DAILY_MAX_REQUESTS: '250',
      MUSICSTUDIO_MIGRATE_ON_START: 'true',
    });

    expect(config.engine).toMatchObject({
      baseUrl: 'http://gpu-box:8001/',
      apiToken: 'engine-token',
      executionLocation: 'remote',
      dailyQuota: { maxRequests: 250, maxGpuSeconds: DEFAULT_ENGINE_DAILY_QUOTA.maxGpuSeconds },
    });
    expect(config.migrateOnStart).toBe(true);
  });

  // Requirement 20.12's domain applies to configuration too: an out-of-range quota would be
  // refused by the registry at boot anyway, and refusing it here names the variable.
  it('rejects an out-of-range daily quota, an unknown execution location and a non-boolean flag', () => {
    expect(() =>
      loadGatewayConfig({ ...REQUIRED, MUSICSTUDIO_ENGINE_DAILY_MAX_REQUESTS: '0' }),
    ).toThrow('MUSICSTUDIO_ENGINE_DAILY_MAX_REQUESTS');
    expect(() =>
      loadGatewayConfig({ ...REQUIRED, MUSICSTUDIO_ENGINE_EXECUTION_LOCATION: 'cloud' }),
    ).toThrow('MUSICSTUDIO_ENGINE_EXECUTION_LOCATION');
    expect(() => loadGatewayConfig({ ...REQUIRED, MUSICSTUDIO_MIGRATE_ON_START: 'maybe' })).toThrow(
      'MUSICSTUDIO_MIGRATE_ON_START',
    );
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
