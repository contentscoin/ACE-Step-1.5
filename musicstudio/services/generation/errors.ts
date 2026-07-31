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
  | 'song_request_invalid'
  /** Requirements 7.2, 7.4, 7.6, 7.7, 7.10, 7.11 — see `edit-errors.ts`. */
  | 'edit_request_invalid'
  /** Requirement 7.9, carrying the models that do support the Edit_Task. */
  | 'edit_task_unsupported'
  | 'edit_source_asset_not_found'
  /** Requirement 7.12 lineage refused by the design §4.2 invariants. */
  | 'edit_lineage_rejected'
  /** Requirements 21.3, 21.9 — see `services/sound/bgm-errors.ts` for the payload. */
  | 'bgm_request_invalid'
  /** Requirement 21.18, carrying the unmet loop criteria and the refunded amount. */
  | 'bgm_loop_quality_unmet'
  /** Requirements 21.10, 21.11 — an intensity ladder the produced variants violate. */
  | 'bgm_intensity_ladder_unmet'
  /** Requirements 22.3, 22.18 — see `services/sound/sfx-errors.ts` for the payload. */
  | 'sfx_request_invalid'
  /**
   * No variant of a sound-effect request survived.
   *
   * The gap Requirement 22.19 leaves: 22.19 legislates for *some* variants failing and says
   * nothing about all of them. 422 rather than 400 for the reason `bgm_loop_quality_unmet` is —
   * nothing about the request was wrong.
   */
  | 'sfx_all_variants_failed'
  /**
   * Requirement 23.1's 1–4 variant cap.
   *
   * A separate code from `v2a_upload_rejected` because the two are refused at different points
   * and for different reasons: this one is a property of the request and is decided before the
   * upload is even probed, so a client can tell "your parameters are wrong" from "your file is".
   */
  | 'v2a_request_rejected'
  /** Requirement 23.4 — see `services/sound/v2a-errors.ts` for the payload. */
  | 'v2a_upload_rejected'
  /**
   * The uploaded container could not be probed at all.
   *
   * The case Requirement 23.4 does not quite reach: 23.4 asks for the measured value of each
   * violated constraint, and an unreadable file yields no measurements. Same 400 status,
   * separate code so a client can tell "your file is too long" from "your file is not a video".
   */
  | 'v2a_upload_unreadable'
  /** Requirement 23.11 — the video rights confirmation of Requirement 16.14 is missing. */
  | 'v2a_upload_consent_missing'
  /** No foley variant survived its Requirement 23.8/23.9/23.12 verdicts. */
  | 'v2a_generation_failed'
  /** Requirement 23.17 — the foley job outran its 900-second budget. */
  | 'v2a_generation_timed_out'
  /** Requirement 25.22 — see `services/speech/speech-errors.ts` for the payload. */
  | 'dialogue_request_invalid'
  /**
   * Requirement 25.14 — the script has no storable line list.
   *
   * A separate code from `dialogue_request_invalid` because the two are about different things: a
   * script of 30 000 characters breaks 25.4's *request* bound, and a script of one 1 500-character
   * line breaks 25.14's *storage* bound while being a perfectly ordinary request. A client can act
   * on the difference — split the line, versus shorten the script.
   */
  | 'dialogue_lines_invalid'
  /** Requirement 25.3, carrying the engines that do support the language. */
  | 'dialogue_language_unsupported'
  /** Requirement 26.11 — a `preset` Voice_Profile used with an engine it is not bound to. */
  | 'voice_profile_engine_locked'
  /** Requirement 25.21, carrying the valid line index range. */
  | 'dialogue_line_index_invalid'
  /** A re-synthesis named an asset this service did not produce. */
  | 'dialogue_asset_not_found'
  /** Requirement 25.1 — no line could be synthesised, so no asset exists. */
  | 'dialogue_generation_failed'
  /** Requirement 26.25 — the conversion's length left the permitted window. */
  | 'voice_conversion_length_unmet'
  /** Requirement 26.24 — the conversion engine produced nothing. */
  | 'voice_conversion_failed'
  /** Requirement 26.24 — the source utterance named by a conversion does not exist. */
  | 'voice_conversion_source_not_found'
  /** Requirements 26.1–26.7 — see `services/voice/profile-errors.ts` for the payload. */
  | 'voice_profile_request_invalid'
  /** Requirements 26.2–26.5 — a reference sample outside the stated bounds. */
  | 'voice_reference_sample_rejected'
  /** A reference sample whose container could not be read at all. */
  | 'voice_reference_sample_unreadable'
  /** Requirements 27.5, 27.15 — see `services/transcription/errors.ts` for the payload. */
  | 'transcription_request_invalid'
  /** Requirement 27.16 — the engine failed, or 27.1's response budget elapsed. */
  | 'transcription_failed'
  /** Requirement 27.17 — a line time edit that would break 27.6, 27.7 or 27.8. */
  | 'transcription_edit_rejected'
  /** Requirement 27.11 — a line text edit outside 1–500 characters. */
  | 'transcription_text_rejected';

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
