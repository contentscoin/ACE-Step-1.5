import { randomUUID } from 'node:crypto';

import { systemClock, type Clock } from './clock';
import type { SessionStore } from './session-store';
import type { TokenPair, TokenService } from './token-service';

export interface SessionIssuer {
  /** Opens a new session and mints the token pair of Requirement 1.3. */
  issue(accountId: string): Promise<{ sessionId: string; tokens: TokenPair }>;
  /** Mints a fresh pair for an already-open session (refresh token exchange). */
  renew(input: { accountId: string; sessionId: string }): Promise<TokenPair>;
  revoke(sessionId: string): Promise<void>;
}

export interface SessionIssuerOptions {
  readonly sessionStore: SessionStore;
  readonly tokenService: TokenService;
  readonly clock?: Clock;
  readonly generateSessionId?: () => string;
}

/**
 * Couples token minting to the session cache.
 *
 * The cache entry is written with the refresh token's expiry so a session never
 * outlives the longest-lived credential that references it, and refreshing
 * extends the same session rather than accumulating new ones.
 */
export function createSessionIssuer(options: SessionIssuerOptions): SessionIssuer {
  const clock = options.clock ?? systemClock;
  const generateSessionId = options.generateSessionId ?? randomUUID;
  const { sessionStore, tokenService } = options;

  async function mint(accountId: string, sessionId: string): Promise<TokenPair> {
    const tokens = await tokenService.issuePair({ accountId, sessionId });
    await sessionStore.save({
      sessionId,
      accountId,
      issuedAt: clock.now(),
      expiresAt: tokens.refreshTokenExpiresAt,
    });
    return tokens;
  }

  return {
    async issue(accountId): Promise<{ sessionId: string; tokens: TokenPair }> {
      const sessionId = generateSessionId();
      return { sessionId, tokens: await mint(accountId, sessionId) };
    },

    async renew({ accountId, sessionId }): Promise<TokenPair> {
      return mint(accountId, sessionId);
    },

    async revoke(sessionId): Promise<void> {
      await sessionStore.delete(sessionId);
    },
  };
}
