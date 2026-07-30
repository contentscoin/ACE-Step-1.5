import { addSeconds, systemClock, type Clock } from './clock';
import { tokenInvalid } from './errors';
import { createJwtSigner, type JwtSigner } from './jwt';

/** Requirement 1.3: access token valid for 24 hours. */
export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Requirement 1.3: refresh token valid for 30 days. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const DEFAULT_TOKEN_ISSUER = 'musicstudio';

export type TokenKind = 'access' | 'refresh';

export interface TokenClaims {
  readonly accountId: string;
  readonly sessionId: string;
  readonly kind: TokenKind;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface TokenPair {
  readonly tokenType: 'Bearer';
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface TokenService {
  issuePair(input: { accountId: string; sessionId: string }): Promise<TokenPair>;
  verify(token: string, expectedKind: TokenKind): Promise<TokenClaims>;
}

export interface JwtTokenServiceOptions {
  readonly secret: string;
  readonly clock?: Clock;
  readonly issuer?: string;
  readonly signer?: JwtSigner;
}

/**
 * Issues and verifies the access/refresh pair of Requirement 1.3.
 *
 * A token names both the account and the session it was minted for. The
 * session identifier is what lets the Redis session cache revoke a token pair
 * before its `exp` (design §2.4).
 */
export function createJwtTokenService(options: JwtTokenServiceOptions): TokenService {
  const clock = options.clock ?? systemClock;
  const issuer = options.issuer ?? DEFAULT_TOKEN_ISSUER;
  const signer = options.signer ?? createJwtSigner(options.secret);

  async function issue(
    kind: TokenKind,
    accountId: string,
    sessionId: string,
    issuedAt: Date,
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = addSeconds(issuedAt, ttlSeconds);
    const token = await signer.sign({
      subject: accountId,
      issuer,
      issuedAt,
      expiresAt,
      claims: { kind, sid: sessionId },
    });
    return { token, expiresAt };
  }

  return {
    async issuePair({ accountId, sessionId }): Promise<TokenPair> {
      const issuedAt = clock.now();
      const access = await issue('access', accountId, sessionId, issuedAt, ACCESS_TOKEN_TTL_SECONDS);
      const refresh = await issue(
        'refresh',
        accountId,
        sessionId,
        issuedAt,
        REFRESH_TOKEN_TTL_SECONDS,
      );

      return {
        tokenType: 'Bearer',
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: refresh.token,
        refreshTokenExpiresAt: refresh.expiresAt,
      };
    },

    async verify(token, expectedKind): Promise<TokenClaims> {
      const verified = await signer.verify(token, { issuer, currentDate: clock.now() });

      const kind = verified.payload.kind;
      if (kind !== expectedKind) {
        throw tokenInvalid(`expected a ${expectedKind} token`);
      }

      const sessionId = verified.payload.sid;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw tokenInvalid('missing session claim');
      }

      return {
        accountId: verified.subject,
        sessionId,
        kind: expectedKind,
        issuedAt: verified.issuedAt,
        expiresAt: verified.expiresAt,
      };
    },
  };
}
