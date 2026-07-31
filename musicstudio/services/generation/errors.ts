/**
 * Job_Orchestrator failure vocabulary.
 *
 * Same shape as `services/account/errors.ts` and `adapters/registry/errors.ts`
 * (status code, machine-readable `code`, detail bag) so the single gateway error
 * contract in `api/gateway/error-handler.ts` renders it without a new branch.
 *
 * Requirement 6.6 has no entry here on purpose. "Every engine supporting this
 * Asset_Kind is unhealthy" is already the Provider_Registry's availability state,
 * and it already has a rejection with exactly the payload 6.6 wants: 503
 * `no_available_engine`, carrying each candidate's last check time and result.
 * Re-deriving health in this service would create a second, drifting answer to the
 * same question, so submission simply lets the routing rejection through and the
 * maintenance notice is that response.
 */

export type GenerationErrorCode =
  | 'generation_job_not_found'
  | 'generation_job_not_cancellable'
  | 'generation_job_not_retryable'
  | 'generation_job_forbidden'
  /** Requirements 3.5, 3.8, 4.6 — see `song-errors.ts` for the payload. */
  | 'song_request_invalid';

export class GenerationError extends Error {
  readonly statusCode: number;
  readonly code: GenerationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    statusCode: number,
    code: GenerationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'GenerationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isGenerationError(value: unknown): value is GenerationError {
  return value instanceof GenerationError;
}

export function jobNotFound(jobId: string): GenerationError {
  return new GenerationError(404, 'generation_job_not_found', 'No such Generation_Job.', { jobId });
}

/**
 * A job owned by someone else is reported as forbidden rather than missing.
 *
 * The job id is only obtainable from the owner's own submit response, so revealing
 * existence to a caller that already holds the identifier discloses nothing, and
 * 403 is the honest answer.
 */
export function jobForbidden(jobId: string): GenerationError {
  return new GenerationError(403, 'generation_job_forbidden', 'The job belongs to another account.', {
    jobId,
  });
}

/** Requirement 5.7 permits cancelling a job that is still pending. */
export function jobNotCancellable(jobId: string, state: string): GenerationError {
  return new GenerationError(
    409,
    'generation_job_not_cancellable',
    'Only a pending Generation_Job can be cancelled.',
    { jobId, state },
  );
}

/**
 * Requirement 6.4 retries a *failed* job, and only when its Requirement 6.1
 * classification says a retry could behave differently.
 */
export function jobNotRetryable(
  jobId: string,
  detail: { readonly state: string; readonly classification?: string },
): GenerationError {
  return new GenerationError(
    409,
    'generation_job_not_retryable',
    'The Generation_Job cannot be retried.',
    { jobId, ...detail },
  );
}
