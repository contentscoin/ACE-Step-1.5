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
  | 'transcription_text_rejected'
  /** Requirement 24.20 — see `services/sound/sound-pack-errors.ts` for the payload. */
  | 'sound_pack_request_invalid'
  /** Requirement 24.17 — a regeneration named something outside the Semantic_Cue taxonomy. */
  | 'sound_pack_cue_unknown'
  /**
   * Requirements 24.10, 24.11 — the export did not produce the archive it promised.
   *
   * 500 rather than 422, unlike every quality code above it. A quality miss is a fact about
   * generated audio the user can act on by regenerating; an archive holding 154 of 156 files,
   * or one that took 70 seconds, is this service failing to keep its own promise.
   */
  | 'sound_pack_export_failed'
  /** Requirement 28.1 — no such Timeline_Project, or none owned by this account. */
  | 'timeline_project_not_found'
  | 'timeline_project_forbidden'
  /** Requirements 28.1, 28.39 — a project name, description, tempo or time signature. */
  | 'timeline_project_invalid'
  /**
   * Requirements 28.2, 28.4, 28.10, 28.11, 28.14, 28.16, 28.17, 28.18 — the edit itself.
   *
   * One code for every clip-shaped and track-shaped rejection because they share a payload —
   * the violated fields with their permitted ranges — and a client acts on the payload rather
   * than on the code. The two that do *not* share it get their own codes below.
   */
  | 'timeline_edit_rejected'
  /** Requirement 28.5, carrying the current clip count and the ceiling of 500. */
  | 'timeline_clip_limit_reached'
  /** Requirement 28.8, carrying the conflicting clip identifiers and the overlap length. */
  | 'timeline_clip_overlap'
  /** Requirement 28.38's 이력 부재 사유 코드. */
  | 'timeline_history_empty'
  /** Requirement 28.34 — a clip referencing an Audio_Asset that does not exist. */
  | 'timeline_asset_not_found'
  /** Requirement 28.31 — a JSON project document that could not be parsed. */
  | 'timeline_project_document_invalid'
  /**
   * Requirement 28.29's 렌더링 대상 부재 사유 코드.
   *
   * Its own code rather than a `timeline_edit_rejected` payload: the caller asked to render,
   * not to edit, and 28.29 requires the project to be left untouched — a client that saw an
   * edit rejection would have to guess whether anything had been written.
   */
  | 'mixdown_no_render_target'
  /** Requirement 28.24 — a clip whose Audio_Asset has no stored audio to mix. */
  | 'mixdown_audio_unavailable'
  /**
   * The worker returned a render that breaks an invariant the caller stated — a length
   * outside Requirement 28.25's ±10 ms, or an attenuation outside 28.28's band.
   *
   * Separate from the refusals above because it is not the caller's fault and not
   * retryable by changing the request: the two sides of the seam have drifted. Rendered
   * as 502 for the same reason.
   */
  | 'mixdown_render_invalid'
  /** Requirements 11.1, 11.9 — no such Audio_Asset, or one this account does not own. */
  | 'library_asset_not_found'
  | 'library_asset_forbidden'
  /** Requirements 11.2-11.4, 11.12 — a listing request the library cannot answer. */
  | 'library_query_invalid'
  /** Requirement 11.3's tag rules, carrying every violated tag rather than the first. */
  | 'library_tags_invalid'
  /** Requirement 11.10 — no such playlist, or one this account does not own. */
  | 'library_playlist_not_found'
  | 'library_playlist_forbidden'
  | 'library_playlist_invalid'
  /**
   * Requirements 13.2, 13.4, 13.9 — the download was refused.
   *
   * One code for the three, because a client acts on the payload: `offeredFormats` for a
   * format that is not on offer, `requiredPlanIds` for 13.4's "필요한 요금제". Splitting
   * them would make a client branch on a code to read a field it can just look for.
   */
  | 'library_download_refused'
  /** The asset exists but its audio does not — purged, or never stored. */
  | 'library_audio_unavailable'
  /** Requirement 13.7 — the encoder did not write the AI-generation tag. */
  | 'library_download_tag_missing'
  /** Requirement 12.1 — no such Audio_Asset to play. */
  | 'playback_asset_not_found'
  /**
   * Requirement 12.6 — a private asset, and the requester is not its owner.
   *
   * 404 rather than 403, unlike Requirement 11.9's library refusal. 11.9 states its status
   * for an owner acting on their own library, where existence is already known. A stream
   * URL is guessable and reachable without a session, so answering 403 would confirm that
   * a private asset exists to anyone who asked. The requirement fixes neither code.
   */
  | 'playback_asset_private'
  /** Requirement 12.2 — the requested byte range does not overlap the object. */
  | 'playback_range_unsatisfiable'
  /** The asset exists but its audio does not, so there is nothing to stream. */
  | 'playback_audio_unavailable'
  /** Requirement 12.7 — a bucket count outside the permitted range. */
  | 'playback_waveform_request_invalid'
  /**
   * Requirement 14.4 — the share link names nothing published.
   *
   * The single answer for four different states: never published, revoked, soft-deleted, or
   * withheld by review. 14.4 fixes 404 for the revoked case, and answering anything more
   * specific for the others would tell a stranger holding a stale link which one it is.
   */
  | 'sharing_link_not_found'
  /** Requirements 14.2, 14.4 — publishing or revoking someone else's asset. 403 per 11.9. */
  | 'sharing_asset_forbidden'
  | 'sharing_asset_not_found'
  /** Requirement 14.7 — a like on an asset that is not public. */
  | 'sharing_asset_not_public'
  /** Requirement 14.9 — the owner did not permit remote remixing. */
  | 'sharing_remix_not_permitted'
  /** Requirements 14.5, 14.6 — a malformed feed query. */
  | 'sharing_feed_query_invalid'
  /** Requirement 14.11 — no such Sound_Pack, or it belongs to another account. */
  | 'sharing_sound_pack_not_found'
  | 'sharing_sound_pack_forbidden'
  /** Requirements 15.2, 15.8 — the training request is refused; carries the minimum. */
  | 'persona_request_invalid'
  | 'persona_not_found'
  /** Requirement 15.6 — a persona the requester does not own. 403, stated by the criterion. */
  | 'persona_forbidden'
  /** Requirement 15.5 — the persona exists but is not trained, so there is no adapter. */
  | 'persona_not_ready'
  /** Requirement 15.1 — a reference song that is missing or not the requester's. */
  | 'persona_reference_invalid'
  /**
   * Requirements 33.11, 33.22 — a `commercial` request against a non-commercially-licensed
   * asset. 403 rather than 402: 402 would read as "pay and this works", and 33.22 makes it
   * precisely the case that no plan, tier, operator setting or API key changes the answer.
   */
  | 'commercial_use_not_permitted'
  | 'licensing_asset_not_found'
  /** Requirement 33.10 — a non-commercial engine chosen without confirming the notice. */
  | 'non_commercial_notice_not_confirmed'
  /** Requirement 33.24 — nothing registered for this Asset_Kind permits commercial use. */
  | 'no_commercial_engine_available'
  /** Requirements 18.1, 34.9 — the Admin_Console and the thresholds are operator-only. */
  | 'operator_role_required'
  /** Requirement 34.5 — carries the adjustable range; the stored value is unchanged. */
  | 'quality_threshold_out_of_range'
  /** Requirement 18.9 — diagnostics for a job that does not exist. */
  | 'admin_job_not_found'
  /** Requirement 16.6 — the stored audio does not carry the AI-generation mark. */
  | 'disclosure_watermark_missing';

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
