import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isRegistryError } from '../../adapters/registry/errors';
import { isAccountError } from '../../services/account/errors';
import { isCreditError } from '../../services/credit/errors';
import { isGenerationError } from '../../services/generation/errors';
import { isModerationError } from '../../services/moderation/errors';
import { isVoiceError } from '../../services/voice/errors';

/**
 * Single error contract for the gateway.
 *
 * Every failure body is `{ "error": { "code", "message", ... } }`. The `code`
 * is the machine-readable reason several criteria ask for (1.2 duplicate, 1.8
 * token expiry, 20.5/20.6/20.11/20.13/20.22/20.23 registry rejections,
 * 16.2/16.4/16.11/16.12/16.14 moderation refusals, 2.3/2.6/2.11 credit
 * refusals, 26.13/26.20/26.22/26.29/26.35 voice consent refusals), so clients
 * branch on `code`, never on status alone.
 *
 * Requirement 26.29 is why that matters concretely: a 403 from a withdrawn Voice_Profile
 * and a 403 from a share list both arrive as 403, and only `code` plus
 * `withdrawalReasonCode` tell them apart.
 */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly [key: string]: unknown;
  };
}

const TOKEN_ERROR_CODES = new Set([
  'authorization_header_missing',
  'token_expired',
  'token_invalid',
  'session_not_found',
  'account_not_found',
]);

/**
 * The shape both `AccountError` and `RegistryError` satisfy.
 *
 * Structural rather than a shared base class, so a domain module never has to
 * import a transport type to be renderable by this handler.
 */
interface CodedDomainError {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (
      isAccountError(error) ||
      isRegistryError(error) ||
      isModerationError(error) ||
      isCreditError(error) ||
      isGenerationError(error) ||
      isVoiceError(error)
    ) {
      sendDomainError(reply, error);
      return;
    }

    if (error.validation !== undefined) {
      void reply.code(400).send(body('validation_failed', error.message));
      return;
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled gateway error');
      void reply.code(statusCode).send(body('internal_error', 'An unexpected error occurred.'));
      return;
    }

    void reply.code(statusCode).send(body(error.code ?? 'request_failed', error.message));
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(body('route_not_found', 'The requested route does not exist.'));
  });
}

function sendDomainError(reply: FastifyReply, error: CodedDomainError): void {
  if (error.code === 'login_temporarily_locked') {
    const retryAfter = error.details.retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      reply.header('retry-after', String(retryAfter));
    }
  }
  if (TOKEN_ERROR_CODES.has(error.code)) {
    // RFC 6750 §3: the reason code also travels in the challenge, so a client
    // can distinguish "expired" from "invalid" without parsing the body.
    reply.header('www-authenticate', `Bearer error="${error.code}"`);
  }

  void reply.code(error.statusCode).send({
    error: { code: error.code, message: error.message, ...error.details },
  } satisfies ErrorBody);
}

function body(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
