import { decodeJwt } from 'jose';

import { socialLoginExchangeFailed } from '../errors';
import type {
  AuthorizationUrlRequest,
  CodeExchangeRequest,
  OAuthIdentity,
  OAuthProvider,
} from '../oauth-provider';

/**
 * OAuth 2.0 authorization code flow against an OIDC provider (Requirement 1.7).
 *
 * Google and Apple differ only in endpoints and in how the client secret is
 * produced (Apple signs a short-lived JWT), so both are configurations of this
 * one adapter rather than separate implementations. Credentials arrive through
 * `clientId`/`clientSecret`; nothing here is hard-coded.
 */
export const GOOGLE_OIDC_ENDPOINTS = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scope: 'openid email',
} as const;

export const APPLE_OIDC_ENDPOINTS = {
  authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
  tokenEndpoint: 'https://appleid.apple.com/auth/token',
  scope: 'openid email',
} as const;

export interface OidcProviderConfig {
  readonly id: string;
  readonly clientId: string;
  /** Resolved per request so Apple's rotating client-secret JWT fits too. */
  readonly clientSecret: () => string | Promise<string>;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scope: string;
  /** Apple requires `response_mode=form_post` when the scope includes `email`. */
  readonly responseMode?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createOidcAuthorizationCodeProvider(config: OidcProviderConfig): OAuthProvider {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  return {
    id: config.id,

    buildAuthorizationUrl(request: AuthorizationUrlRequest): string {
      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('scope', config.scope);
      url.searchParams.set('state', request.state);
      url.searchParams.set('nonce', request.nonce);
      if (config.responseMode !== undefined) {
        url.searchParams.set('response_mode', config.responseMode);
      }
      return url.toString();
    },

    async exchangeAuthorizationCode(request: CodeExchangeRequest): Promise<OAuthIdentity> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.redirectUri,
        client_id: config.clientId,
        client_secret: await config.clientSecret(),
      });

      const response = await fetchImpl(config.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      });

      if (!response.ok) {
        throw socialLoginExchangeFailed(config.id, `token endpoint returned ${response.status}`);
      }

      const idToken = extractIdToken(await readJson(response, config.id));
      if (idToken === null) {
        throw socialLoginExchangeFailed(config.id, 'token response contained no id_token');
      }

      return toIdentity(config.id, idToken);
    },
  };
}

async function readJson(response: Response, providerId: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw socialLoginExchangeFailed(providerId, 'token response was not valid JSON');
  }
}

function extractIdToken(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const idToken = (payload as { id_token?: unknown }).id_token;
  return typeof idToken === 'string' && idToken.length > 0 ? idToken : null;
}

/**
 * The ID token is read without signature verification: it was just retrieved
 * over TLS directly from the provider's token endpoint, which RFC 8252 / OIDC
 * Core §3.1.3.7 accept as the issuer-authenticated channel for the code flow.
 */
function toIdentity(providerId: string, idToken: string): OAuthIdentity {
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(idToken);
  } catch {
    throw socialLoginExchangeFailed(providerId, 'id_token could not be decoded');
  }

  const subject = claims.sub;
  const email = claims.email;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw socialLoginExchangeFailed(providerId, 'id_token contained no sub claim');
  }
  if (typeof email !== 'string' || email.length === 0) {
    throw socialLoginExchangeFailed(providerId, 'id_token contained no email claim');
  }

  return {
    provider: providerId,
    subject,
    email,
    // Apple encodes `email_verified` as the string "true" in some responses.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
  };
}
