/**
 * The dialogue request as the user makes it, and the parameter set it resolves to.
 *
 * Two types rather than one, for the reason `domain/sfx/request.ts` gives: the request has
 * optional fields because Requirements 25.5, 25.6 and 25.10 define defaults, and the
 * parameters have none because by the time anything is submitted every omission has been
 * filled and *recorded*. A service reading `SpeechParameters` cannot forget a default.
 *
 * `appliedDefaults` travels with the parameters rather than in a side channel because the
 * three criteria that define a default all say the default is *applied*, and a caller being
 * charged for a generation should be able to see the rate and pitch it actually ran at.
 */

import type { ParalinguisticTag } from './paralinguistic';

export interface DialogueGenerationRequest {
  /** Requirements 25.4, 25.22. */
  readonly script: string;
  /** Requirements 25.1, 25.23, 26.20 — whose voice. */
  readonly voiceProfileId: string;
  /** Requirements 25.2, 25.3, 26.11 — omitted means route by Asset_Kind (Req 20.2). */
  readonly engineId?: string;
  /** Requirements 25.3, 27.3 — ISO 639-1. */
  readonly languageCode: string;
  /** Requirement 25.5. Omitted means 1.0×. */
  readonly speakingRate?: number;
  /** Requirement 25.6. Omitted means 0 semitones. */
  readonly pitchSemitones?: number;
  /** Requirement 25.7. Omitted means none; ignored by an engine that cannot use it. */
  readonly actingInstruction?: string;
  /** Requirement 25.10. Omitted means 800 characters. */
  readonly splitThresholdChars?: number;
  /** Requirement 25.18. Omitted means one is drawn and recorded. */
  readonly seed?: number;
}

/** Requirements 25.5, 25.6, 25.10: the fields a service may fill in. */
export const SPEECH_DEFAULTABLE_FIELDS = [
  'speakingRate',
  'pitchSemitones',
  'splitThresholdChars',
] as const;

export type SpeechDefaultableField = (typeof SPEECH_DEFAULTABLE_FIELDS)[number];

/**
 * A fully determined dialogue request. Every field is present; nothing downstream defaults.
 *
 * `seed` is the exception that proves the rule, exactly as in `SfxParameters`: Requirement
 * 25.18's reproducibility is about a seed the *caller* named, and a drawn seed is a random
 * choice a pure function cannot make. The service draws it through `SeedSource` and records
 * the drawn value on the asset.
 */
export interface SpeechParameters {
  /** The script after 25.9's tag removal, which is what the engine is asked to speak. */
  readonly script: string;
  /** The script as submitted, kept so 25.18's key is about what the user asked for. */
  readonly originalScript: string;
  readonly voiceProfileId: string;
  readonly languageCode: string;
  readonly speakingRate: number;
  readonly pitchSemitones: number;
  /** `null` when none was given, or when the engine does not support 25.7. */
  readonly actingInstruction: string | null;
  readonly splitThresholdChars: number;
  /** Requirement 25.9's 제거된 태그 이름 목록. */
  readonly removedTags: readonly ParalinguisticTag[];
  /** Present only when the caller named one (Requirement 25.18's precondition). */
  readonly seed?: number;
  readonly appliedDefaults: readonly SpeechDefaultableField[];
}

/**
 * The subset of parameters Requirement 25.18 makes the reproducibility key.
 *
 * 25.18 lists exactly six things — 시드, 스크립트, Voice_Profile, 엔진, 발화 속도, 음높이 조정 —
 * and *not* the split threshold, the language code or the acting instruction. That omission is
 * respected rather than corrected: the key is what the criterion says it is. It is also what
 * makes the property honest, because a key that included every field would be trivially
 * satisfied by any engine that ignored some of them.
 *
 * **Reported as a spec observation.** The split threshold changes where the 50 ms cross-fades
 * land, so two requests differing only in it can produce different samples while sharing
 * 25.18's key. This implementation avoids the contradiction by synthesising per *line* (see
 * `services/speech/speech-service.ts`), which makes the seam positions a function of the
 * script rather than of the threshold — so 25.18 holds as written.
 */
export interface DialogueReproducibilityKey {
  readonly seed: number;
  readonly script: string;
  readonly voiceProfileId: string;
  readonly engineId: string;
  readonly speakingRate: number;
  readonly pitchSemitones: number;
}

/**
 * Characters of script one second of speech covers at 1.0× rate.
 *
 * **A product decision, and deliberately a conservative one.** Requirement 25 states no bound on a
 * dialogue asset's *audio* length — only 25.4's 20 000-character script limit — yet a
 * Generation_Job needs a duration: Requirement 2.2 prices by it and Requirement 20.6 routes by it,
 * refusing a request longer than the engine's declared maximum. So an estimate is unavoidable, and
 * the direction of the error matters: under-estimating would have routing refuse a script 25.4
 * permits.
 *
 * Six characters per second is slower than any script this system will see. A Latin-script speaker
 * manages 10–20 and a Korean speaker 5–7 *syllable blocks* per second, so six characters is at or
 * below the slower of the two — which makes the figure an upper bound on the audio length rather
 * than a guess at it.
 *
 * The cost of over-estimating is that Requirement 2.2's price is computed from a duration longer
 * than the result. **Reported with this task as an open question**: Requirement 25 gives no dialogue
 * price basis, and whether dialogue should be priced by script length rather than by estimated
 * duration is a decision for whoever owns the pricing table.
 */
export const SCRIPT_CHARACTERS_PER_SECOND = 6;

/**
 * Longest an Audio_Asset may be, milliseconds (Requirements 19.11, 19.15).
 *
 * Also `MAX_OUTPUT_DURATION_MS_MAX` in `adapters/registry/engine-descriptor.ts`, so no engine can
 * declare a longer reach and no job can be routed past it.
 */
export const DIALOGUE_DURATION_MS_CEILING = 3_600_000;

/**
 * The duration a dialogue Generation_Job declares, in milliseconds.
 *
 * Scaled by the speaking rate, because 25.5's rate is exactly the factor that changes how long a
 * given script takes: at 2.0× the same text is half the audio.
 *
 * **Clamped to Requirement 19.11's one-hour asset ceiling, which 25.4 can exceed.** 20 000
 * characters at six characters per second and 0.5× is about 6 700 seconds — nearly twice what an
 * Audio_Asset may be. So the longest scripts 25.4 permits cannot be one asset at the slowest rate
 * 25.5 permits, and clamping is what keeps routing from refusing outright. **Reported as a spec
 * tension between 25.4, 25.5 and 19.11**: nothing in Requirement 25 says what should happen to a
 * script whose speech would exceed the asset length limit.
 */
export function estimatedDialogueDurationMs(script: string, speakingRate: number): number {
  const rate = speakingRate > 0 ? speakingRate : 1;
  const seconds = script.length / SCRIPT_CHARACTERS_PER_SECOND / rate;
  // At least one second: `MAX_OUTPUT_DURATION_MS_MIN` is 1000 ms, and a one-character script must
  // still be a routable request.
  return Math.min(DIALOGUE_DURATION_MS_CEILING, Math.max(1_000, Math.round(seconds * 1000)));
}

export function dialogueReproducibilityKey(
  parameters: SpeechParameters,
  engineId: string,
  seed: number,
): DialogueReproducibilityKey {
  return {
    seed,
    script: parameters.originalScript,
    voiceProfileId: parameters.voiceProfileId,
    engineId,
    speakingRate: parameters.speakingRate,
    pitchSemitones: parameters.pitchSemitones,
  };
}

/**
 * Requirement 25.15's key: the values a re-synthesised line must reuse.
 *
 * 25.15 names the Voice_Profile, the engine, the speaking rate and the pitch, and *not* the
 * seed — but a re-synthesis that redrew the seed would produce different audio for the same
 * line every time, so the line's original seed is carried too. Stated as its own type so the
 * re-synthesis path cannot quietly substitute a fresh parameter set.
 */
export interface LineResynthesisKey extends DialogueReproducibilityKey {
  readonly lineIndex: number;
  readonly languageCode: string;
  readonly actingInstruction: string | null;
}
