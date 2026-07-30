import { socialLoginNotConfigured } from './errors';

/**
 * Requirement 1.7 — OAuth 2.0 authorization code flow, behind an interface.
 *
 * Providers are registered from configuration; the requirement's
 * `WHERE 소셜 로그인 제공자가 설정된 경우` guard is exactly "this registry has an
 * entry". No provider identifier, endpoint or secret is hard-coded in the
 * domain layer.
 */
export const SUPPORTED_SOCIAL_PROVIDERS = ['google', 'apple'] as const;

export type SocialProviderId = (typeof SUPPORTED_SOCIAL_PROVIDERS)[number];

export function isSupportedSocialProvider(value: string): value is SocialProviderId {
  return (SUPPORTED_SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

/** Identity asserted by the provider after a successful code exchange. */
export interface OAuthIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface AuthorizationUrlRequest {
  readonly state: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

export interface CodeExchangeRequest {
  readonly code: string;
  readonly redirectUri: string;
}

export interface OAuthProvider {
  readonly id: string;
  buildAuthorizationUrl(request: AuthorizationUrlRequest): string;
  exchangeAuthorizationCode(request: CodeExchangeRequest): Promise<OAuthIdentity>;
}

export interface OAuthProviderRegistry {
  isConfigured(providerId: string): boolean;
  /** Throws `social_login_not_configured` (404) for unconfigured providers. */
  get(providerId: string): OAuthProvider;
  configuredProviderIds(): readonly string[];
}

export function createOAuthProviderRegistry(
  providers: readonly OAuthProvider[],
): OAuthProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  return {
    isConfigured: (providerId) => byId.has(providerId),

    get(providerId) {
      const provider = byId.get(providerId);
      if (provider === undefined) {
        throw socialLoginNotConfigured(providerId);
      }
      return provider;
    },

    configuredProviderIds: () => [...byId.keys()].sort(),
  };
}
