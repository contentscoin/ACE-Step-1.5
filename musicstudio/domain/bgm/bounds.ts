/**
 * Bounds Requirement 21 states as *structure*, kept apart from the perceptual
 * thresholds of Requirement 34.
 *
 * The split is the point of this module. A scene description of 2001 characters is
 * not a matter of taste that an operator should be able to retune; a seam RMS
 * difference of 1.05 dB is. So the counts, ranges and window lengths live here as
 * constants, and every threshold a listener could argue about lives in
 * `domain/quality/threshold-set.ts` and is read from the set in force.
 *
 * The two window lengths below sit on the boundary and are worth justifying. 10 ms
 * (21.7) and 100 ms (21.16) are *what is measured*, not *how strictly*: they define
 * the quantity, and the ceiling applied to that quantity is the adjustable part. A
 * threshold set that could change the window would change the meaning of the number
 * recorded on every earlier asset, which Requirement 34.10 forbids.
 */

/** Requirements 21.3, 21.5. */
export const BGM_SCENE_DESCRIPTION_MIN_LENGTH = 1;
export const BGM_SCENE_DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * Requirements 21.2, 21.3.
 *
 * The floor is 5 s, five seconds below the 10 s floor Requirement 4.2 and the
 * engine's own `DURATION_MIN` impose on a song. That is deliberate in the
 * requirements — a 5-second loop is a normal ask — and it is why the song validator
 * takes its duration window as a parameter rather than hard-coding one.
 *
 * **Unverified:** whether ACE-Step accepts a 5-second request at all, or whether the
 * product layer must ask for 10 s and trim. §14 risk to raise with the engine owner.
 */
export const BGM_TARGET_LENGTH_SECONDS_MIN = 5;
export const BGM_TARGET_LENGTH_SECONDS_MAX = 600;

/** Requirement 21.9. */
export const BGM_INTENSITY_VARIANT_COUNT_MIN = 1;
export const BGM_INTENSITY_VARIANT_COUNT_MAX = 4;

/** Requirement 21.11: the intensity step recorded on each variant. */
export const BGM_INTENSITY_STEP_MIN = 1;
export const BGM_INTENSITY_STEP_MAX = 4;

/** Requirement 21.11: permitted loudness gap between adjacent steps, LUFS. */
export const BGM_INTENSITY_GAP_MIN_LUFS = 1.0;
export const BGM_INTENSITY_GAP_MAX_LUFS = 6.0;

/** Requirement 21.10: length spread across one cue's variants. */
export const BGM_VARIANT_DURATION_SPREAD_MAX_MS = 10;

/** Requirement 21.17: permitted whole-bar multiples for a loop. */
export const BGM_LOOP_BAR_MULTIPLE_MIN = 1;
export const BGM_LOOP_BAR_MULTIPLE_MAX = 64;

/** Requirement 21.13: BPM agreement with a reference asset. */
export const BGM_REFERENCE_BPM_TOLERANCE = 1;

/** Requirement 21.7: the seam window, measured either side of the loop point. */
export const BGM_SEAM_WINDOW_MS = 10;

/** Requirement 21.16: the edge window at each end of the loop. */
export const BGM_EDGE_WINDOW_MS = 100;

/** Requirement 21.18: two regenerations after the first attempt, so three in all. */
export const BGM_LOOP_QUALITY_MAX_ATTEMPTS = 3;

export function isBgmTargetLengthSeconds(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= BGM_TARGET_LENGTH_SECONDS_MIN &&
    value <= BGM_TARGET_LENGTH_SECONDS_MAX
  );
}

export function isBgmSceneDescription(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length >= BGM_SCENE_DESCRIPTION_MIN_LENGTH &&
    value.length <= BGM_SCENE_DESCRIPTION_MAX_LENGTH
  );
}

export function isBgmVariantCount(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= BGM_INTENSITY_VARIANT_COUNT_MIN &&
    (value as number) <= BGM_INTENSITY_VARIANT_COUNT_MAX
  );
}

export function isBgmIntensityStep(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= BGM_INTENSITY_STEP_MIN &&
    (value as number) <= BGM_INTENSITY_STEP_MAX
  );
}
