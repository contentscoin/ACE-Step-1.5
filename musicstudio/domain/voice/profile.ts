/**
 * Voice_Profile — the type, the name and the engine binding (Requirements 26.1, 26.7,
 * 26.9–26.11).
 *
 * **This extends task 6.2's row rather than replacing it.** The consent state and the
 * withdrawal context are `consent-state.ts` and `withdrawal-machine.ts`, stored on the same
 * `voice_profile` row (see `db/migrations/0011_voice_consent.sql`, which says so). What task
 * 2.7 adds is the profile's own identity: `cloned` or `preset`, the name, the reference
 * samples, and — for a preset — the engine it is bound to.
 *
 * ### The two types are not variations of one shape
 *
 * A `cloned` profile is defined by reference samples the user uploaded (26.1–26.8) and may be
 * used with any engine that supports the requested language. A `preset` profile is a catalogue
 * entry (26.9) and is **locked** to the engine it came from (26.10), because the voice
 * identifier only means anything to that engine — asking engine B for engine A's `voice_042`
 * would either fail or, worse, return a different voice. So the two are a discriminated union
 * and the engine binding exists only on one arm; a single shape with a nullable `engineId`
 * would let a `cloned` profile be accidentally locked and a `preset` one accidentally freed.
 *
 * ### Reference samples belong to the profile, not to a consent record
 *
 * 26.7 bounds them per profile, 26.8 combines them into one voice prompt, and 26.21 (task 6.2)
 * erases them on deletion. The consent record (26.12) is what *permits* them to be stored; it
 * is not where they live.
 */

import { lengthViolation, rangeViolation, type SongFieldViolation } from '../song/violation';

/** Requirement 26.1 — 프로필 이름 길이. */
export const VOICE_PROFILE_NAME_MIN_LENGTH = 1;
export const VOICE_PROFILE_NAME_MAX_LENGTH = 64;

/** Requirement 26.7 — 참조 샘플 개수. */
export const REFERENCE_SAMPLE_COUNT_MIN = 1;
export const REFERENCE_SAMPLE_COUNT_MAX = 10;

export const VOICE_PROFILE_TYPES = ['cloned', 'preset'] as const;

export type VoiceProfileType = (typeof VOICE_PROFILE_TYPES)[number];

export function isVoiceProfileType(value: unknown): value is VoiceProfileType {
  return typeof value === 'string' && (VOICE_PROFILE_TYPES as readonly string[]).includes(value);
}

/** One stored reference sample, and the text Requirement 26.6 derived from it. */
export interface ReferenceSample {
  readonly uploadId: string;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly format: string;
  /** Requirement 26.6 — 참조 텍스트, produced by the Transcription_Service. */
  readonly referenceText: string;
}

export interface ClonedVoiceProfile {
  readonly kind: 'cloned';
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly name: string;
  /** Requirement 26.7 — 1개 이상 10개 이하. */
  readonly referenceSamples: readonly ReferenceSample[];
  /** Requirement 26.8 — the combined prompt handle, once two or more samples exist. */
  readonly voicePromptId: string | null;
  /** Requirements 26.12–26.15: the record that permitted the clone. */
  readonly consentRecordId: string;
  readonly createdAtMs: number;
}

export interface PresetVoiceProfile {
  readonly kind: 'preset';
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly name: string;
  /** Requirement 26.9 — the catalogue entry this profile names. */
  readonly voiceId: string;
  /** Requirement 26.10 — 카탈로그 출처 엔진, fixed. */
  readonly engineId: string;
  readonly languageCode: string;
  readonly createdAtMs: number;
}

export type VoiceProfile = ClonedVoiceProfile | PresetVoiceProfile;

/**
 * Requirement 26.10 — the engine a profile is locked to, or `null` when it is not locked.
 *
 * One accessor rather than a field read at every call site, so 26.11's refusal and the
 * submission path cannot disagree about what "the profile's engine" means.
 */
export function boundEngineIdOf(profile: VoiceProfile): string | null {
  return profile.kind === 'preset' ? profile.engineId : null;
}

export type EngineBindingCheck =
  | { readonly outcome: 'permitted' }
  /** Requirement 26.11 — the caller named an engine the preset is not bound to. */
  | { readonly outcome: 'refused'; readonly boundEngineId: string; readonly requestedEngineId: string };

/**
 * Requirements 26.10, 26.11 — may this profile be used with `requestedEngineId`?
 *
 * An omitted engine is permitted: routing will select the bound engine for a preset (the
 * caller named nothing to contradict) and the Asset_Kind default for a clone. Refusing an
 * omitted engine would make 26.10's binding a burden on the caller rather than a guarantee.
 */
export function checkEngineBinding(
  profile: VoiceProfile,
  requestedEngineId: string | undefined,
): EngineBindingCheck {
  const bound = boundEngineIdOf(profile);
  if (bound === null || requestedEngineId === undefined || requestedEngineId === bound) {
    return { outcome: 'permitted' };
  }
  return { outcome: 'refused', boundEngineId: bound, requestedEngineId };
}

/**
 * Requirement 26.10 — the engine a submission for this profile must use.
 *
 * `undefined` for a clone, which means "let routing decide" (Requirement 20.2's default engine
 * for `dialogue`, with 20.10's fallback).
 */
export function submissionEngineIdOf(
  profile: VoiceProfile,
  requestedEngineId?: string,
): string | undefined {
  return boundEngineIdOf(profile) ?? requestedEngineId;
}

export type ProfileNameValidation =
  | { readonly kind: 'valid'; readonly name: string }
  | { readonly kind: 'invalid'; readonly violation: SongFieldViolation };

/**
 * Requirement 26.1 — 1자 이상 64자 이하.
 *
 * Measured trimmed and stored trimmed, so a name of spaces is refused rather than stored as a
 * profile with no visible label.
 */
export function validateProfileName(name: unknown): ProfileNameValidation {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (
    trimmed.length < VOICE_PROFILE_NAME_MIN_LENGTH ||
    trimmed.length > VOICE_PROFILE_NAME_MAX_LENGTH
  ) {
    return {
      kind: 'invalid',
      violation: lengthViolation(
        'name',
        trimmed.length,
        VOICE_PROFILE_NAME_MIN_LENGTH,
        VOICE_PROFILE_NAME_MAX_LENGTH,
      ),
    };
  }
  return { kind: 'valid', name: trimmed };
}

export type ReferenceCountValidation =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly violation: SongFieldViolation };

/** Requirement 26.7 — the count, checked before anything is stored. */
export function validateReferenceSampleCount(count: number): ReferenceCountValidation {
  if (count < REFERENCE_SAMPLE_COUNT_MIN || count > REFERENCE_SAMPLE_COUNT_MAX) {
    return {
      kind: 'invalid',
      violation: rangeViolation(
        'referenceSampleCount',
        count,
        REFERENCE_SAMPLE_COUNT_MIN,
        REFERENCE_SAMPLE_COUNT_MAX,
      ),
    };
  }
  return { kind: 'valid' };
}

/**
 * Requirement 26.8 — does this profile need a combined voice prompt?
 *
 * True from the second sample onwards. A single-sample profile uses that sample directly, which
 * is why 26.8 is conditioned on "2개 이상 존재하면" rather than being unconditional.
 */
export function needsCombinedPrompt(profile: ClonedVoiceProfile): boolean {
  return profile.referenceSamples.length >= 2;
}
