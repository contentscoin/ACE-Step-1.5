import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  createOidcAuthorizationCodeProvider,
  GOOGLE_OIDC_ENDPOINTS,
} from '../../../services/account/adapters/oidc-provider';

async function idTokenWith(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode('provider-signing-key-32-characters!'));
}

function providerWith(response: { status?: number; body?: unknown }) {
  const requests: { url: string; body: string }[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    requests,
    provider: createOidcAuthorizationCodeProvider({
      id: 'google',
      clientId: 'client-id-from-config',
      clientSecret: () => 'client-secret-from-config',
      fetchImpl,
      ...GOOGLE_OIDC_ENDPOINTS,
    }),
  };
}

/** Requirement 1.7 — OAuth 2.0 authorization code flow. */
describe('OIDC authorization code provider', () => {
  it('builds an authorization URL carrying state, nonce and the configured client', () => {
    const { provider } = providerWith({});

    const url = new URL(
      provider.buildAuthorizationUrl({
        state: 'state-1',
        nonce: 'nonce-1',
        redirectUri: 'https://studio.test/callback',
      }),
    );

    expect(url.origin + url.pathname).toBe(GOOGLE_OIDC_ENDPOINTS.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-id-from-config',
      redirect_uri: 'https://studio.test/callback',
      state: 'state-1',
      nonce: 'nonce-1',
      scope: GOOGLE_OIDC_ENDPOINTS.scope,
    });
  });

  it('exchanges the code and reads the identity from the id_token', async () => {
    const idToken = await idTokenWith({
      sub: 'google-subject-1',
      email: 'creator@example.com',
      email_verified: true,
    });
    const { provider, requests } = providerWith({ body: { id_token: idToken } });

    const identity = await provider.exchangeAuthorizationCode({
      code: 'authorization-code-1',
      redirectUri: 'https://studio.test/callback',
    });

    expect(identity).toEqual({
      provider: 'google',
      subject: 'google-subject-1',
      email: 'creator@example.com',
      emailVerified: true,
    });
    expect(requests[0]?.url).toBe(GOOGLE_OIDC_ENDPOINTS.tokenEndpoint);
    expect(requests[0]?.body).toContain('grant_type=authorization_code');
    expect(requests[0]?.body).toContain('code=authorization-code-1');
  });

  it('accepts the string form of email_verified that Apple sends', async () => {
    const idToken = await idTokenWith({
      sub: 'apple-subject-1',
      email: 'creator@example.com',
      email_verified: 'true',
    });
    const { provider } = providerWith({ body: { id_token: idToken } });

    const identity = await provider.exchangeAuthorizationCode({
      code: 'authorization-code-1',
      redirectUri: 'https://studio.test/callback',
    });

    expect(identity.emailVerified).toBe(true);
  });

  it('surfaces a token endpoint failure as an upstream error', async () => {
    const { provider } = providerWith({ status: 400, body: { error: 'invalid_grant' } });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'stale-code',
        redirectUri: 'https://studio.test/callback',
      }),
    ).rejects.toMatchObject({ statusCode: 502, code: 'social_login_exchange_failed' });
  });

  it('rejects a token response with no id_token', async () => {
    const { provider } = providerWith({ body: { access_token: 'opaque' } });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'authorization-code-1',
        redirectUri: 'https://studio.test/callback',
      }),
    ).rejects.toMatchObject({ code: 'social_login_exchange_failed' });
  });

  it('rejects an id_token with no email claim', async () => {
    const idToken = await idTokenWith({ sub: 'google-subject-1' });
    const { provider } = providerWith({ body: { id_token: idToken } });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'authorization-code-1',
        redirectUri: 'https://studio.test/callback',
      }),
    ).rejects.toMatchObject({ code: 'social_login_exchange_failed' });
  });
});
