/**
 * Bounds Requirement 24 states as *structure*, kept apart from the perceptual thresholds
 * of Requirement 34.
 *
 * Same split as `domain/sfx/bounds.ts` and `domain/v2a/bounds.ts`, for the same reason.
 * A cue count of 78 is not a matter of taste an operator should be able to retune; the
 * −25…−21 LUFS window of 24.7 and the 0.95 similarity ceiling of 24.9 are, and
 * Requirement 34.1 names both as Quality_Threshold_Set members. So counts, length ranges,
 * window lengths and file counts live here as constants, and every adjustable number is
 * read through `domain/quality/sound-pack-thresholds.ts`.
 *
 * The **length ranges of 24.4 and 24.5 are here, not in the threshold set**, and that is a
 * deliberate reading rather than an oversight. Requirement 34.1's enumeration names "사운드
 * 팩 라우드니스 허용 범위" and "큐 쌍 유사도 상한" and does *not* name the cue length
 * ranges — and the split it implies is the right one on its own terms: 1.5 seconds is a
 * statement about what a UI one-shot *is* (design §8.3 budgets a click, not a sting),
 * while −23 LUFS is a judgement about how loud one should feel. Moving a length bound
 * would change which cues are admissible in a way no calibration review would ask for.
 *
 * The measurement **windows** of 24.6, 24.7 and 24.8 are also here, by the rule
 * `domain/sfx/bounds.ts` states: a window defines *what is measured*, so moving one would
 * change the meaning of every number already recorded against an earlier threshold-set
 * version, which Requirement 34.10 forbids.
 */

/** Requirement 24.1: the pack name and the sonic-character description. */
export const PACK_NAME_MIN_LENGTH = 1;
export const PACK_NAME_MAX_LENGTH = 60;
export const PACK_DESCRIPTION_MIN_LENGTH = 1;
export const PACK_DESCRIPTION_MAX_LENGTH = 200;

/** Requirement 24.1/24.2: the taxonomy's counts, restated as the numbers the rules use. */
export const PACK_CUE_COUNT = 78;
export const PACK_CATEGORY_COUNT = 13;
export const PACK_ONE_SHOT_COUNT = 72;
export const PACK_LOOP_COUNT = 6;

/**
 * Requirement 24.9's pair count: `78 · 77 / 2`.
 *
 * Stated as a constant because the clause states it ("서로 다른 모든 큐 쌍 3003개") and
 * because it is the number a pairwise check must *reach* — a similarity report holding
 * fewer pairs than this has not examined the pack the clause describes, and that is a far
 * more likely defect than a wrong threshold.
 */
export const PACK_CUE_PAIR_COUNT = (PACK_CUE_COUNT * (PACK_CUE_COUNT - 1)) / 2;

/** Requirement 24.4: the one-shot length range, in seconds. */
export const ONE_SHOT_LENGTH_SECONDS_MIN = 0.05;
export const ONE_SHOT_LENGTH_SECONDS_MAX = 1.5;

/** Requirement 24.5: the loop length range, in seconds. */
export const LOOP_LENGTH_SECONDS_MIN = 0.5;
export const LOOP_LENGTH_SECONDS_MAX = 4.0;

/** Requirement 24.6: the seam window, measured at each end of a loop cue. */
export const CUE_SEAM_WINDOW_MS = 10;

/** Requirement 24.8: the tail window of a one-shot cue. */
export const CUE_TAIL_WINDOW_MS = 50;

/**
 * Requirement 24.7: the loudness window and the interval between windows.
 *
 * 400 ms at 100 ms intervals is exactly BS.1770-4's gating block at 75 % overlap, which is
 * why `domain/audio/loudness.ts` computes both quantities from one K-weighting pass rather
 * than growing a second one. What differs is the *reduction*: 24.7 takes the maximum over
 * windows, and the integrated measurement takes a gated mean. See `maxShortTermLoudnessLufs`.
 */
export const PACK_LOUDNESS_WINDOW_MS = 400;
export const PACK_LOUDNESS_HOP_MS = 100;

/** Requirement 24.9's MFCC parameters. The measurement itself is the DSP worker's. */
export const CUE_MFCC_DIMENSIONS = 13;
export const CUE_MFCC_MEL_BANDS = 40;
export const CUE_MFCC_WINDOW_MS = 25;
export const CUE_MFCC_HOP_MS = 10;
/** Requirement 24.9's normalisation target, before the MFCC is taken. */
export const CUE_MFCC_NORMALISATION_LUFS = -23.0;
/** Requirement 24.9: the rate and channel count the comparison is made at. */
export const CUE_MFCC_SAMPLE_RATE = 48_000;
export const CUE_MFCC_CHANNELS = 1;

/** Requirement 24.9: the similarity value's range, inclusive. */
export const CUE_SIMILARITY_MIN = -1.0;
export const CUE_SIMILARITY_MAX = 1.0;

/** Requirement 24.10: one mp3 and one ogg per cue, and the rate they are written at. */
export const PACK_EXPORT_FORMATS = ['mp3', 'ogg'] as const;
export type PackExportFormat = (typeof PACK_EXPORT_FORMATS)[number];
export const PACK_EXPORT_FILE_COUNT = PACK_CUE_COUNT * PACK_EXPORT_FORMATS.length;
export const PACK_EXPORT_SAMPLE_RATE = 48_000;

/**
 * Requirement 24.21: retries per cue whose generation failed.
 *
 * "최대 2회 재시도" — two retries after the first attempt, so at most three attempts.
 * Both numbers are named, because off-by-one between "retries" and "attempts" is the
 * classic way a bound of two becomes a bound of three.
 */
export const CUE_GENERATION_RETRIES_MAX = 2;
export const CUE_GENERATION_ATTEMPTS_MAX = CUE_GENERATION_RETRIES_MAX + 1;

/**
 * Requirement 24.22: regenerations of a cue that is too similar to another.
 *
 * "서로 다른 시드로 최대 3회 재생성" — three regenerations, each with a different seed.
 */
export const CUE_SIMILARITY_REGENERATIONS_MAX = 3;

/**
 * Requirement 24.1's parallelism: 8 cue generations in flight at once.
 *
 * From task 3.4's brief rather than from a clause — Requirement 24 does not state a
 * concurrency, and 8 is the same ceiling Requirement 22.16 puts on sibling variants, so a
 * pack asks the engine no more at once than a single sound-effect request may.
 *
 * Not a Quality_Threshold_Set member: it changes how fast a pack is produced, never which
 * audio is admissible, so Requirement 34.1's list does not name it and neither does the
 * accessor in `domain/quality/sound-pack-thresholds.ts`.
 */
export const PACK_GENERATION_CONCURRENCY = 8;

/** Requirement 24.11: the default volume range, matching design §8.3's `setVolume`. */
export const CUE_DEFAULT_VOLUME_MIN = 0.0;
export const CUE_DEFAULT_VOLUME_MAX = 1.0;

export function isPackName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length >= PACK_NAME_MIN_LENGTH &&
    value.length <= PACK_NAME_MAX_LENGTH
  );
}

export function isPackDescription(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length >= PACK_DESCRIPTION_MIN_LENGTH &&
    value.length <= PACK_DESCRIPTION_MAX_LENGTH
  );
}

/**
 * Requirements 24.4 and 24.5: the permitted length range for a cue, by kind.
 *
 * One function rather than two constants at every call site, because the two ranges are
 * mutually exclusive and picked by exactly one predicate — `isLoopCue`. A caller that had
 * to choose could choose wrongly; a caller that passes the flag cannot.
 */
export function cueLengthRangeSeconds(loop: boolean): { readonly min: number; readonly max: number } {
  return loop
    ? { min: LOOP_LENGTH_SECONDS_MIN, max: LOOP_LENGTH_SECONDS_MAX }
    : { min: ONE_SHOT_LENGTH_SECONDS_MIN, max: ONE_SHOT_LENGTH_SECONDS_MAX };
}

export function isCueLengthSeconds(seconds: unknown, loop: boolean): boolean {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return false;
  const range = cueLengthRangeSeconds(loop);
  return seconds >= range.min && seconds <= range.max;
}

export function isCueDefaultVolume(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= CUE_DEFAULT_VOLUME_MIN &&
    value <= CUE_DEFAULT_VOLUME_MAX
  );
}
