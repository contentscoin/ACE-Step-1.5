import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isAccountError, type AccountError } from '../../services/account/errors';

/**
 * Single error contract for the gateway.
 *
 * Every failure body is `{ "error": { "code", "message", ... } }`. The `code`
 * is the machine-readable reason Requirement 1 asks for in several places
 * (1.2 duplicate, 1.8 token expiry), so clients branch on `code`, never on
 * status alone.
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

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (isAccountError(error)) {
      sendAccountError(reply, error);
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

function sendAccountError(reply: FastifyReply, error: AccountError): void {
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
