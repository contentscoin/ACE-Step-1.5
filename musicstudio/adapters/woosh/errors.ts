/**
 * Woosh engine failure vocabulary.
 *
 * Same shape as `adapters/ace/errors.ts` — status code, machine-readable `code`, detail bag
 * — so the gateway's single error contract renders it with no new branch and, more
 * importantly, so `classifyEngineFailure` can read the HTTP status off a thrown error.
 * Requirement 6.2's backoff keys on exactly that: a 429 is the queue-saturation case that
 * earns a re-request, and everything else is not.
 */

export type WooshErrorCode =
  | 'woosh_engine_http_error'
  | 'woosh_engine_application_error'
  | 'woosh_engine_malformed_response'
  | 'woosh_engine_task_unknown';

export class WooshEngineError extends Error {
  readonly statusCode: number;
  readonly code: WooshErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    statusCode: number,
    code: WooshErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'WooshEngineError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isWooshEngineError(value: unknown): value is WooshEngineError {
  return value instanceof WooshEngineError;
}

/** Non-2xx. The status is preserved rather than flattened, for Requirement 6.2. */
export function wooshHttpError(
  httpStatus: number,
  path: string,
  detail?: string,
): WooshEngineError {
  return new WooshEngineError(
    httpStatus,
    'woosh_engine_http_error',
    `Woosh answered ${String(httpStatus)} for ${path}.`,
    detail === undefined ? { path } : { path, detail },
  );
}

/** HTTP 200 with an envelope reporting failure in `code`/`error`. */
export function wooshApplicationError(
  path: string,
  envelopeCode: unknown,
  envelopeError: unknown,
): WooshEngineError {
  return new WooshEngineError(
    502,
    'woosh_engine_application_error',
    `Woosh reported an error for ${path}.`,
    { path, envelopeCode, envelopeError },
  );
}

export function wooshMalformedResponse(path: string, reason: string): WooshEngineError {
  return new WooshEngineError(502, 'woosh_engine_malformed_response', reason, { path });
}

/** The status route returned no entry for a task the adapter had submitted. */
export function wooshTaskUnknown(engineJobId: string): WooshEngineError {
  return new WooshEngineError(
    502,
    'woosh_engine_task_unknown',
    'Woosh does not know this task.',
    { engineJobId },
  );
}
