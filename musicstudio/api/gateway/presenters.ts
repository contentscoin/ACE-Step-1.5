import type { FastifyReply } from 'fastify';

import type { Clock } from '../../services/clock';
import type { SubmitOutcome } from '../../services/generation/job-orchestrator';
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

/**
 * `SubmitOutcome` on the wire (Requirements 5.1, 6.1, 16.2, 16.11).
 *
 * Three status codes for three outcomes, and the distinction is the point: 202 for accepted,
 * 422 for a job the engine refused — "your request was accepted and then failed", not "your
 * request was malformed" — and 403 for a request the content policy blocked before anything
 * could charge for it.
 *
 * This lived in `song-routes.ts` and again, identically, in `generation-routes.ts`. Task 9.1
 * would have made it three copies: the Public_API of Requirement 17 is a façade over the same
 * gateways, so a caller must not be told a different story about the same outcome depending on
 * which surface they came in through. Extracted rather than copied for that reason.
 */
export function presentSubmitOutcome(
  reply: FastifyReply,
  outcome: SubmitOutcome,
  extra: Readonly<Record<string, unknown>> = {},
): FastifyReply {
  if (outcome.kind === 'accepted') {
    return reply.code(202).send({ ...outcome.acceptance, ...extra });
  }

  if (outcome.kind === 'failed') {
    return reply.code(422).send({
      error: {
        code: 'generation_job_failed',
        message: 'The engine did not accept the Generation_Job.',
        jobId: outcome.jobId,
        classification: outcome.failure.classification,
        retryable: outcome.failure.retryable,
        reason: outcome.failure.reason,
      },
    });
  }

  return reply.code(403).send({
    error: {
      code: 'blocked_by_moderation',
      message: 'The request was blocked by the content policy.',
      blockCodes: outcome.decision.blocks.map((block) => block.code),
      violationClasses: outcome.decision.violationClasses,
    },
  });
}
