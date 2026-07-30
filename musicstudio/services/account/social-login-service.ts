import { randomUUID } from 'node:crypto';

import type { AccountRepository } from './account-repository';
import { systemClock, type Clock } from './clock';
import { normalizeEmail } from './email';
import { socialLoginStateMismatch } from './errors';
import type { OAuthProviderRegistry } from './oauth-provider';
import type { SessionIssuer } from './session-issuer';
import type { TokenPair } from './token-service';

export interface StartedAuthorization {
  readonly provider: string;
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
}

export interface SocialLoginResult {
  readonly accountId: string;
  readonly email: string;
  readonly accountCreated: boolean;
  readonly tokens: TokenPair;
}

export interface SocialLoginService {
  beginAuthorization(input: {
    provider: string;
    redirectUri: string;
  }): Promise<StartedAuthorization>;

  completeAuthorization(input: {
    provider: string;
    code: string;
    redirectUri: string;
    state: string;
    expectedState: string;
  }): Promise<SocialLoginResult>;
}

export interface SocialLoginServiceOptions {
  readonly registry: OAuthProviderRegistry;
  readonly repository: AccountRepository;
  readonly sessionIssuer: SessionIssuer;
  readonly clock?: Clock;
  readonly generateAccountId?: () => string;
  readonly generateState?: () => string;
}

/**
 * Requirement 1.7: authorization code flow, then account resolution.
 *
 * Resolution order — existing identity, then existing address (linked), then a
 * new password-less account. Linking by verified address is what keeps a user
 * who signed up with a password from ending up with a second account after
 * choosing "Continue with Google".
 */
export function createSocialLoginService(
  options: SocialLoginServiceOptions,
): SocialLoginService {
  const clock = options.clock ?? systemClock;
  const generateAccountId = options.generateAccountId ?? randomUUID;
  const generateState = options.generateState ?? randomUUID;
  const { registry, repository, sessionIssuer } = options;

  return {
    async beginAuthorization({ provider, redirectUri }): Promise<StartedAuthorization> {
      const oauthProvider = registry.get(provider);
      const state = generateState();
      const nonce = generateState();

      return {
        provider: oauthProvider.id,
        authorizationUrl: oauthProvider.buildAuthorizationUrl({ state, nonce, redirectUri }),
        state,
        nonce,
      };
    },

    async completeAuthorization(input): Promise<SocialLoginResult> {
      const oauthProvider = registry.get(input.provider);
      if (input.state.length === 0 || input.state !== input.expectedState) {
        throw socialLoginStateMismatch();
      }

      const identity = await oauthProvider.exchangeAuthorizationCode({
        code: input.code,
        redirectUri: input.redirectUri,
      });
      const email = normalizeEmail(identity.email);
      const link = { provider: oauthProvider.id, subject: identity.subject };

      const linked = await repository.findBySocialIdentity(link);
      if (linked !== null) {
        return finish(linked.id, linked.email, false);
      }

      const existing = await repository.findByEmail(email);
      if (existing !== null) {
        await repository.linkSocialIdentity(existing.id, link);
        return finish(existing.id, existing.email, false);
      }

      const now = clock.now();
      const created = await repository.create({
        id: generateAccountId(),
        email,
        // No local credential exists for a provider-only account; Requirement
        // 1.6 is satisfied vacuously rather than with a placeholder hash.
        passwordHash: null,
        emailVerifiedAt: identity.emailVerified ? now : null,
        createdAt: now,
        socialIdentities: [link],
      });
      return finish(created.id, created.email, true);
    },
  };

  async function finish(
    accountId: string,
    email: string,
    accountCreated: boolean,
  ): Promise<SocialLoginResult> {
    const { tokens } = await sessionIssuer.issue(accountId);
    return { accountId, email, accountCreated, tokens };
  }
}
