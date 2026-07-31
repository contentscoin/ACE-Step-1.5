/**
 * Generation_Job failure classification (Requirement 6.1).
 *
 * 6.1 asks for two things back on a failure: which of three classes it belongs to
 * (input error, engine error, resource exhaustion) and whether a retry is worth
 * attempting. The second is not stored independently — it is *derived* from the
 * class, because "an input error is retryable" is not a state the system should be
 * able to reach. Retrying an input error with the identical parameters Requirement
 * 6.4 mandates would fail identically, so the class decides.
 *
 * Pure: no clock, no I/O. Classification is a function of the engine's own signal.
 */

export const JOB_FAILURE_CLASSES = ['input_error', 'engine_error', 'resource_exhaustion'] as const;

export type JobFailureClass = (typeof JOB_FAILURE_CLASSES)[number];

/**
 * Whether a class is worth retrying with unchanged input.
 *
 * A total record rather than a predicate with a default, so adding a class forces
 * a decision here instead of silently inheriting "retryable".
 */
export const RETRYABLE_FAILURE_CLASSES: Readonly<Record<JobFailureClass, boolean>> = {
  input_error: false,
  engine_error: true,
  resource_exhaustion: true,
};

export function isRetryableFailureClass(classification: JobFailureClass): boolean {
  return RETRYABLE_FAILURE_CLASSES[classification];
}

/** Why the job failed, in machine-readable form. */
export const JOB_FAILURE_REASONS = [
  /** The engine answered with status 2 (design §3.1). */
  'engine_reported_failure',
  /** Requirement 6.3: every permitted re-request failed. */
  'retries_exhausted',
  /** Requirement 5.8: not terminal within the job budget. */
  'job_timeout',
  /** Requirement 20.15: one remote call exceeded its own 300 s cap. */
  'engine_timeout',
  /**
   * Requirement 21.18: three loop attempts, none meeting the seam criteria.
   *
   * Classified as `engine_error` and therefore retryable, because a different seed is
   * exactly what Requirement 21.18 already tried and what a Requirement 6.4 retry would
   * try again — the input was never at fault.
   */
  'loop_quality_unmet',
] as const;

export type JobFailureReason = (typeof JOB_FAILURE_REASONS)[number];

export interface JobFailure {
  readonly classification: JobFailureClass;
  /** Always `isRetryableFailureClass(classification)`; see `jobFailure`. */
  readonly retryable: boolean;
  readonly reason: JobFailureReason;
  /** Engine-supplied text, kept for diagnosis. Never a credential. */
  readonly detail: string | null;
}

/** The only constructor, so `retryable` cannot disagree with `classification`. */
export function jobFailure(
  classification: JobFailureClass,
  reason: JobFailureReason,
  detail: string | null = null,
): JobFailure {
  return {
    classification,
    retryable: isRetryableFailureClass(classification),
    reason,
    detail,
  };
}

/** What the engine told us, in whichever of the two forms it used. */
export interface EngineFailureSignal {
  /** Present when the engine answered over HTTP with an error status. */
  readonly httpStatus?: number;
  /** Present when the engine reported a failure reason on a poll. */
  readonly reason?: string;
}

const INPUT_ERROR_TERMS = [
  'invalid',
  'unsupported',
  'validation',
  'out of range',
  'malformed',
  'too long',
  'bad request',
];

const RESOURCE_TERMS = [
  'out of memory',
  'oom',
  'capacity',
  'queue full',
  'saturat',
  'quota',
  'no gpu',
  'resource',
  'overload',
];

/**
 * Requirement 6.1 classification.
 *
 * HTTP status is trusted over free text when both are present, because a status
 * is a contract and a reason string is prose. 429 is singled out as resource
 * exhaustion rather than lumped in with the other 4xx client errors: Requirement
 * 6.2 makes it the one 4xx that is retried, and that is only coherent if it is
 * not classified as an input error.
 */
export function classifyEngineFailure(
  signal: EngineFailureSignal,
  reasonCode: JobFailureReason = 'engine_reported_failure',
): JobFailure {
  const detail = signal.reason ?? null;
  const status = signal.httpStatus;

  if (status !== undefined) {
    if (status === 429) return jobFailure('resource_exhaustion', reasonCode, detail);
    if (status >= 400 && status < 500) return jobFailure('input_error', reasonCode, detail);
    return jobFailure('engine_error', reasonCode, detail);
  }

  const text = (signal.reason ?? '').toLowerCase();
  if (RESOURCE_TERMS.some((term) => text.includes(term))) {
    return jobFailure('resource_exhaustion', reasonCode, detail);
  }
  if (INPUT_ERROR_TERMS.some((term) => text.includes(term))) {
    return jobFailure('input_error', reasonCode, detail);
  }
  return jobFailure('engine_error', reasonCode, detail);
}

/** Requirement 5.8: the job outlived its 900 s budget. */
export function jobTimeoutFailure(detail: string | null = null): JobFailure {
  return jobFailure('engine_error', 'job_timeout', detail);
}

/**
 * Requirement 6.3: the permitted re-requests are spent.
 *
 * The class of the last signal is preserved so the answer to 6.1 does not change
 * merely because the attempt counter ran out.
 */
export function retriesExhaustedFailure(last: JobFailure): JobFailure {
  return jobFailure(last.classification, 'retries_exhausted', last.detail);
}
