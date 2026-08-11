/**
 * API-key authentication and rate limiting for the developer surface.
 *
 * Requirements 17.3 (Bearer), 17.4 (401), 17.7 and 17.8 (per-key limit, with the retry time).
 *
 * ### Two hooks, in this order
 *
 * Authentication first, then the limit. The other order would count requests against a key that
 * has not been shown to exist, which means an unauthenticated caller can fill any key's window
 * by guessing its identifier — a denial of service delivered through the rate limiter. Limiting
 * *after* authentication also makes the counter's key the account's own credential, which is
 * what Requirement 17.7 says (API 키별).
 *
 * ### The 401 says nothing
 *
 * Missing, malformed, unknown and revoked are one response. `services/public-api/errors.ts`
 * sets out why: distinguishing them answers the question an attacker holding a candidate key is
 * asking.
 */

import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { AuthenticatedApiKey } from '../../services/public-api/api-key-service';
import type { ApiKeyService } from '../../services/public-api/api-key-service';
import { publicApiKeyInvalid } from '../../services/public-api/errors';
import type { RateLimiter } from '../../services/public-api/rate-limiter';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `createApiKeyAuthenticationHook` on the developer surface. */
    authenticatedApiKey: AuthenticatedApiKey | null;
  }
}

const BEARER_PREFIX = 'bearer ';

export function registerApiKeyDecorator(app: FastifyInstance): void {
  app.decorateRequest('authenticatedApiKey', null);
}

export function createApiKeyAuthenticationHook(apiKeys: ApiKeyService): preHandlerHookHandler {
  return async function authenticateApiKey(request): Promise<void> {
    const authenticated = await apiKeys.authenticate(readBearerToken(request));
    if (authenticated === null) throw publicApiKeyInvalid();
    request.authenticatedApiKey = authenticated;
  };
}

/**
 * Requirements 17.7, 17.8.
 *
 * Sets `X-RateLimit-*` on the admitted response as well as `Retry-After` on the refusal. The
 * headers on success are what let a client pace itself instead of discovering the ceiling by
 * hitting it — which is the difference between a limit that shapes traffic and one that only
 * punishes it.
 */
export function createRateLimitHook(limiter: RateLimiter): preHandlerHookHandler {
  return async function limitApiKey(request, reply): Promise<void> {
    const key = request.authenticatedApiKey;
    // Only reachable if this hook is mounted without the authentication hook before it, which
    // would be the composition error the module header describes.
    if (key === null) throw publicApiKeyInvalid();

    const decision = await limiter.consume(key.keyId, key.requestsPerMinute);
    void reply.header('X-RateLimit-Limit', String(decision.limit));
    void reply.header('X-RateLimit-Remaining', String(decision.remaining));
    void reply.header('X-RateLimit-Reset', String(Math.floor(decision.retryAtMs / 1_000)));
  };
}

/** The authenticated key, or the same 401 as any other failure. */
export function requireApiKey(request: FastifyRequest): AuthenticatedApiKey {
  const key = request.authenticatedApiKey;
  if (key === null) throw publicApiKeyInvalid();
  return key;
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}
