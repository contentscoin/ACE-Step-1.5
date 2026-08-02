/**
 * ACE-Step engine failure vocabulary.
 *
 * Same shape as `adapters/registry/errors.ts` (status code, machine-readable
 * `code`, detail bag), so the gateway's single error contract renders it and — more
 * importantly here — so `classifyEngineFailure` can read the HTTP status off a
 * thrown error. Requirement 6.2's backoff keys on exactly that: `statusCode` 429
 * is the queue-saturation case the engine signals when its job queue is full
 * (`release_task_route.py` raises 429 "Server busy: queue is full").
 */

export type AceErrorCode =
  | 'ace_engine_http_error'
  | 'ace_engine_application_error'
  | 'ace_engine_malformed_response'
  | 'ace_engine_task_unknown';

export class AceEngineError extends Error {
  readonly statusCode: number;
  readonly code: AceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    statusCode: number,
    code: AceErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AceEngineError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isAceEngineError(value: unknown): value is AceEngineError {
  return value instanceof AceEngineError;
}

/**
 * The engine answered with a non-2xx status.
 *
 * The status is preserved rather than flattened to 502, because Requirement 6.2
 * treats 429 differently from every other failure.
 */
export function aceHttpError(
  httpStatus: number,
  path: string,
  detail?: string,
): AceEngineError {
  return new AceEngineError(
    httpStatus,
    'ace_engine_http_error',
    `ACE-Step answered ${String(httpStatus)} for ${path}.`,
    detail === undefined ? { path } : { path, detail },
  );
}

/** HTTP 200 with an envelope reporting failure in `code`/`error`. */
export function aceApplicationError(
  path: string,
  envelopeCode: unknown,
  envelopeError: unknown,
): AceEngineError {
  return new AceEngineError(
    502,
    'ace_engine_application_error',
    `ACE-Step reported an error for ${path}.`,
    { path, envelopeCode, envelopeError },
  );
}

export function aceMalformedResponse(path: string, reason: string): AceEngineError {
  return new AceEngineError(502, 'ace_engine_malformed_response', reason, { path });
}

/** `/query_result` returned no entry for a task the adapter had submitted. */
export function aceTaskUnknown(engineJobId: string): AceEngineError {
  return new AceEngineError(502, 'ace_engine_task_unknown', 'ACE-Step does not know this task.', {
    engineJobId,
  });
}
