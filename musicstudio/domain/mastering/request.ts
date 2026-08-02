/**
 * The three mastering requests as the user makes them, and the parameter sets they
 * resolve to (Requirements 30.5, 30.13, 30.14, 30.15).
 *
 * Two types per operation rather than one, for the reason `domain/sfx/request.ts` gives:
 * the request has optional fields because Requirement 30.5 and 30.13–30.15 each name a
 * default, and the resolved parameters have none — so a service reading the parameters
 * cannot forget a default, and the response can report which values were applied on the
 * user's behalf.
 *
 * `appliedDefaults` travels inside the parameters rather than beside them for the same
 * reason: it has to survive as far as the response is built, and the parameters are the
 * only thing that travels the whole way.
 *
 * ### Why dialogue cleanup has no parameters
 *
 * Requirement 30.9 and 30.10 state what cleanup must *achieve* — a ≥10 dB reduction
 * outside speech, speech loudness held within ±1.0 LUFS, length preserved within ±10 ms —
 * and name no input the user supplies. Every number involved is either a
 * Quality_Threshold_Set member or the speech-detection rule of 30.12. So the request is
 * the subject alone, and there is deliberately no `attenuationDb` field: exposing one
 * would let a caller ask for 4 dB and get a version that fails 30.9.
 */

/** Which stored audio a mastering request is about. */
export interface MasteringSubject {
  readonly assetId: string;
  /** The `Generation_Version` the operation reads. Requirement 30.25 preserves it. */
  readonly versionId: string;
}

/** Requirement 30.5's request: a target, or nothing and take −14.0 LUFS. */
export interface LoudnessNormalizationRequest {
  readonly subject: MasteringSubject;
  /** Requirement 30.5: −30.0…−6.0 LUFS in 0.1 steps. Omitted means −14.0. */
  readonly targetLufs?: number;
}

export const LOUDNESS_DEFAULTABLE_FIELDS = ['targetLufs'] as const;
export type LoudnessDefaultableField = (typeof LOUDNESS_DEFAULTABLE_FIELDS)[number];

export interface LoudnessNormalizationParameters {
  readonly targetLufs: number;
  /** Requirement 30.5: which field the service filled in, for the response. */
  readonly appliedDefaults: readonly LoudnessDefaultableField[];
}

/** Requirement 30.9's request. See the module comment on why it carries no numbers. */
export interface DialogueCleanupRequest {
  readonly subject: MasteringSubject;
}

/**
 * Requirement 30.12's request: two tracks and three shaping numbers.
 *
 * The two subjects are named separately and not as an array, because the operation is not
 * symmetric — 30.12 detects speech in the dialogue track and attenuates the *music*
 * track. An array of two would make "which one gets ducked" positional and therefore
 * easy to swap silently.
 */
export interface DuckingRequest {
  /** The track speech is detected in (Requirement 30.12). Never modified. */
  readonly dialogueSubject: MasteringSubject;
  /** The track whose volume is attenuated (Requirement 30.12). */
  readonly musicSubject: MasteringSubject;
  /** Requirement 30.13: −24…−3 dB. Omitted means −12. */
  readonly depthDb?: number;
  /** Requirement 30.14: 10…500 ms. Omitted means 50. */
  readonly attackMs?: number;
  /** Requirement 30.15: 50…2000 ms. Omitted means 300. */
  readonly releaseMs?: number;
}

export const DUCKING_DEFAULTABLE_FIELDS = ['depthDb', 'attackMs', 'releaseMs'] as const;
export type DuckingDefaultableField = (typeof DUCKING_DEFAULTABLE_FIELDS)[number];

export interface DuckingParameters {
  readonly depthDb: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly appliedDefaults: readonly DuckingDefaultableField[];
}
