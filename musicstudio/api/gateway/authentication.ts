import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { AccountService } from '../../services/account/account-service';
import { authorizationHeaderMissing } from '../../services/account/errors';
import type { AuthenticatedAccount } from '../../services/account/login-service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `createAuthenticationHook` on protected routes. */
    authenticatedAccount: AuthenticatedAccount | null;
  }
}

const BEARER_PREFIX = 'bearer ';

/**
 * Auth middleware for the API gateway (design §2.2 "API Gateway / Auth
 * Middleware").
 *
 * Runs as a `preHandler`, so a rejected request never reaches a route handler.
 * Verification covers three things in order: a Bearer token is present, the
 * access token is valid and unexpired (Requirement 1.8 -> 401 `token_expired`),
 * and the session is still live in the Redis cache (design §2.4), which is what
 * makes logout take effect before the token's own expiry.
 */
export function registerAuthenticationDecorator(app: FastifyInstance): void {
  app.decorateRequest('authenticatedAccount', null);
}

export function createAuthenticationHook(
  accountService: Pick<AccountService, 'authenticateAccessToken'>,
): preHandlerHookHandler {
  return async function authenticate(request): Promise<void> {
    const token = readBearerToken(request);
    if (token === null) {
      throw authorizationHeaderMissing();
    }
    request.authenticatedAccount = await accountService.authenticateAccessToken(token);
  };
}

/**
 * The same verification, but a missing credential is allowed through (Requirement 12.6).
 *
 * The playback routes need this. Requirement 12.6 gates a *private* asset, so a public one is
 * playable by someone who is not signed in — Requirement 14.3's public page has no account to
 * offer — and a hook that demanded a token would make that page impossible to serve. The
 * decision then belongs to `Playback_Service`, which admits the owner, admits anything publicly
 * visible, and refuses the rest.
 *
 * A *bad* token is still rejected. Treating an expired token as anonymity would answer "this
 * asset is private" to a signed-in owner whose token had just lapsed, which reads as a
 * permissions bug rather than as the expiry it is.
 */
export function createOptionalAuthenticationHook(
  accountService: Pick<AccountService, 'authenticateAccessToken'>,
): preHandlerHookHandler {
  return async function authenticateOptional(request): Promise<void> {
    const token = readBearerToken(request);
    if (token === null) {
      request.authenticatedAccount = null;
      return;
    }
    request.authenticatedAccount = await accountService.authenticateAccessToken(token);
  };
}

/** Returns the authenticated account, or throws if the hook did not run. */
export function requireAccount(request: FastifyRequest): AuthenticatedAccount {
  const account = request.authenticatedAccount;
  if (account === null) {
    throw authorizationHeaderMissing();
  }
  return account;
}

/** The caller's identifier, or `null` on a route that admits anonymous requests. */
export function optionalAccountId(request: FastifyRequest): string | null {
  return request.authenticatedAccount?.accountId ?? null;
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}
