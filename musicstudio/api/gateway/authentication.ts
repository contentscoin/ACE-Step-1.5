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

/** Returns the authenticated account, or throws if the hook did not run. */
export function requireAccount(request: FastifyRequest): AuthenticatedAccount {
  const account = request.authenticatedAccount;
  if (account === null) {
    throw authorizationHeaderMissing();
  }
  return account;
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}
