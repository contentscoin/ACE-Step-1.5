import type { Clock } from '../../services/clock';
import type { LoginResult } from '../../services/account/login-service';
import type { SocialLoginResult } from '../../services/account/social-login-service';

/**
 * Wire representations of a token pair.
 *
 * Both the absolute instant and the remaining lifetime are returned: the
 * absolute value is what Requirement 1.3 fixes (24 hours / 30 days), while
 * `*_ExpiresInSeconds` is what a client actually schedules its refresh on.
 */
export interface TokenPairBody {
  readonly accountId: string;
  readonly email: string;
  readonly tokenType: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly accessTokenExpiresInSeconds: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly refreshTokenExpiresInSeconds: number;
}

export function presentLogin(result: LoginResult, clock: Clock): TokenPairBody {
  const now = clock.now();
  const { tokens } = result;

  return {
    accountId: result.accountId,
    email: result.email,
    tokenType: tokens.tokenType,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    accessTokenExpiresInSeconds: secondsUntil(tokens.accessTokenExpiresAt, now),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    refreshTokenExpiresInSeconds: secondsUntil(tokens.refreshTokenExpiresAt, now),
  };
}

export function presentSocialLogin(
  result: SocialLoginResult,
  clock: Clock,
): TokenPairBody & { accountCreated: boolean } {
  return {
    ...presentLogin({ accountId: result.accountId, email: result.email, tokens: result.tokens }, clock),
    accountCreated: result.accountCreated,
  };
}

function secondsUntil(instant: Date, now: Date): number {
  return Math.max(0, Math.floor((instant.getTime() - now.getTime()) / 1000));
}
