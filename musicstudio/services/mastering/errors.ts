/**
 * How `Mastering_Assistant` refuses (Requirements 30.6–30.12, 30.16, 30.22, 30.26).
 *
 * Returned, not thrown, for the reason `services/effects/version-manager.ts` gives: every
 * refusal in Requirement 30 specifies a *payload*. 30.26 wants the violated parameter names
 * and their permitted ranges; 30.25 wants the achieved loudness and the shortfall. An
 * exception carrying a formatted string would force the API layer to parse its own error
 * message to build a response body.
 *
 * Requirement 30.26 additionally requires that a refused request create no new
 * `Generation_Version`. That is structural here rather than remembered: every refusal path
 * returns before the version set is touched, and the version set is only ever produced by
 * `createDerivedVersion`, which no refusal path calls.
 */

import type { AutomationDefect } from '../../domain/mastering/ducking';
import type { SuggestionDefect } from '../../domain/mastering/suggestion';
import type { SongFieldViolation } from '../../domain/song/violation';
import type { VersionRefusal } from '../effects/version-manager';

export type MasteringRefusalCode =
  /** Requirement 30.26: a parameter outside 30.5/30.13/30.14/30.15's ranges. */
  | 'parameter_out_of_range'
  /**
   * Requirement 30.6's precondition failed: no gating block cleared the −70 LUFS absolute
   * gate, so there is no integrated loudness to normalise towards.
   *
   * A refusal rather than a silent no-op, because a user who asked for −14 LUFS and got
   * their file back unchanged with a success response would have no way to tell that from
   * a normalisation that happened to need no gain.
   */
  | 'not_measurable'
  /** Requirement 30.7 breached by the worker's output: the ceiling is an invariant. */
  | 'true_peak_ceiling_exceeded'
  /** Requirement 30.9 breached: the non-speech sections were not attenuated enough. */
  | 'non_speech_attenuation_insufficient'
  /** Requirement 30.9 breached: the speech sections' loudness moved too far. */
  | 'speech_loudness_moved'
  /** Requirement 30.10 breached: the cleanup changed the length. */
  | 'length_not_preserved'
  /** Requirement 30.12 or 30.16 breached by the returned automation curve. */
  | 'ducking_curve_invalid'
  /** Requirements 30.2, 30.22 breached by both the model *and* the built-in fallback. */
  | 'suggestion_unusable';

export interface MasteringRefusal {
  readonly ok: false;
  readonly code: MasteringRefusalCode | VersionRefusal['code'];
  /** Requirement 30.26: which parameters, and what would have been accepted. */
  readonly violations?: readonly SongFieldViolation[];
  readonly automationDefects?: readonly AutomationDefect[];
  readonly suggestionDefects?: readonly SuggestionDefect[];
  readonly versionRefusal?: VersionRefusal;
  /** The measured quantity that breached its bound, and the bound. */
  readonly measured?: number;
  readonly bound?: number;
  readonly detail?: string;
}

export function refuse(
  code: MasteringRefusal['code'],
  rest: Omit<Partial<MasteringRefusal>, 'ok' | 'code'> = {},
): MasteringRefusal {
  return { ok: false, code, ...rest };
}
