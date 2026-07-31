import type { OAuthIdentity, OAuthProvider } from '../../services/account/oauth-provider';

/**
 * OAuth provider double for Requirement 1.7.
 *
 * It records the authorization request and returns a fixed identity for the
 * code exchange, which keeps the account-resolution rules (existing identity /
 * link by address / create) testable without contacting Google or Apple.
 */
export interface StubOAuthProvider extends OAuthProvider {
  readonly exchangedCodes: readonly string[];
}

export function createStubOAuthProvider(
  id: string,
  identity: Omit<OAuthIdentity, 'provider'>,
): StubOAuthProvider {
  const exchangedCodes: string[] = [];

  return {
    id,
    exchangedCodes,

    buildAuthorizationUrl({ state, nonce, redirectUri }) {
      const url = new URL(`https://oauth.test/${id}/authorize`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('redirect_uri', redirectUri);
      return url.toString();
    },

    async exchangeAuthorizationCode({ code }) {
      exchangedCodes.push(code);
      return { provider: id, ...identity };
    },
  };
}
