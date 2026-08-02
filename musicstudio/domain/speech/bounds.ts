/**
 * Bounds Requirement 25 states as *structure*, kept apart from the perceptual thresholds
 * of Requirement 34.
 *
 * The same split as `domain/sfx/bounds.ts` and `domain/v2a/bounds.ts`, and the same two
 * questions decide which side a number falls on:
 *
 * - *Would changing it change what a recorded value means?* Then it is a constant. The
 *   split-position rule of 25.11, the 50 ms cross-fade of 25.11/25.15, the 1 ms length
 *   -change threshold of 25.16 and the line bounds of 25.14 are all of this kind: they
 *   define what a chunk, a splice or a line *is*, and every stored timing is expressed in
 *   terms of them.
 * - *Would changing it change only which audio is admissible?* Then it belongs to the
 *   Quality_Threshold_Set — see `domain/quality/speech-thresholds.ts`, which owns
 *   25.19's silence floor and 50–200 ms window and 26.25's ±100 ms tolerance.
 *
 * The input ranges of 25.4–25.10 are constants for a third reason, the one
 * `domain/v2a/bounds.ts` gives: they are the shape of a *request the system accepts*, not
 * a judgement about output quality. A speaking rate of 2.5× is not a matter of taste an
 * operator should retune; it is outside what the engines are asked to do.
 */

/** Requirements 25.4, 25.22 — the whole script, in characters. */
export const SCRIPT_MIN_LENGTH = 1;
export const SCRIPT_MAX_LENGTH = 20_000;

/** Requirements 25.5, 25.22 — 발화 속도, as a multiplier. */
export const SPEAKING_RATE_MIN = 0.5;
export const SPEAKING_RATE_MAX = 2.0;
export const SPEAKING_RATE_DEFAULT = 1.0;

/** Requirements 25.6, 25.22 — 음높이 조정, in semitones. */
export const PITCH_SEMITONES_MIN = -12;
export const PITCH_SEMITONES_MAX = 12;
export const PITCH_SEMITONES_DEFAULT = 0;

/** Requirements 25.7, 25.22 — 연기 지시 문구. No minimum: an empty instruction is none. */
export const ACTING_INSTRUCTION_MAX_LENGTH = 200;

/** Requirements 25.10, 25.22 — 분할 기준 문자 수. */
export const SPLIT_THRESHOLD_MIN = 100;
export const SPLIT_THRESHOLD_MAX = 5_000;
export const SPLIT_THRESHOLD_DEFAULT = 800;

/** Requirement 25.14 — stored lines per dialogue asset. */
export const DIALOGUE_LINE_COUNT_MIN = 1;
export const DIALOGUE_LINE_COUNT_MAX = 1_000;

/** Requirement 25.14 — characters per stored line. */
export const DIALOGUE_LINE_LENGTH_MIN = 1;
export const DIALOGUE_LINE_LENGTH_MAX = 1_000;

/**
 * Requirement 25.11 — the only characters after which a split is permitted.
 *
 * Four terminators, exactly as the criterion lists them, including the ideographic full
 * stop. A line boundary is the other permitted position and is handled separately, because
 * `\n` is a separator rather than a terminator: the split goes *after* it either way, but a
 * newline is not part of a sentence the way a period is.
 */
export const SENTENCE_TERMINATORS = ['.', '?', '!', '。'] as const;

export type SentenceTerminator = (typeof SENTENCE_TERMINATORS)[number];

export function isSentenceTerminator(character: string): boolean {
  return (SENTENCE_TERMINATORS as readonly string[]).includes(character);
}

/**
 * Requirements 25.11, 25.15 — the splice length, milliseconds.
 *
 * The same 50 ms `domain/audio/crossfade.ts` implements and Requirement 23.7 uses; the
 * requirements appendix lists all three criteria under one entry. Re-exported through the
 * shared constant rather than restated as a literal, so a change lands in one place.
 */
export { CROSSFADE_OVERLAP_MS as DIALOGUE_CROSSFADE_MS } from '../audio/crossfade';

/**
 * Requirement 25.16 — the length change at which re-timing applies, milliseconds.
 *
 * Below it, nothing moves. A constant rather than a threshold: it is the resolution at
 * which two synthesis lengths are declared the same, which is a property of the timing
 * model the API publishes, not a judgement about audio. The same reasoning
 * `domain/sfx/bounds.ts` gives for `SFX_ALIGNMENT_TIE_TOLERANCE`.
 */
export const LINE_LENGTH_CHANGE_THRESHOLD_MS = 1;

/**
 * Requirement 25.15 — the region either side of a splice whose samples may change.
 *
 * 25.15 preserves every non-regenerated line's samples "접합 경계 전후 각 50밀리초 구간을
 * 제외하고". That exclusion is exactly one cross-fade either side of the seam, so it is the
 * cross-fade length rather than an independent number.
 */
export const SPLICE_TOLERANCE_MS = 50;

export function isSpeakingRate(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= SPEAKING_RATE_MIN &&
    value <= SPEAKING_RATE_MAX
  );
}

export function isPitchSemitones(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= PITCH_SEMITONES_MIN &&
    value <= PITCH_SEMITONES_MAX
  );
}

export function isSplitThresholdChars(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= SPLIT_THRESHOLD_MIN &&
    (value as number) <= SPLIT_THRESHOLD_MAX
  );
}
