/**
 * Bounds Requirement 22 states as *structure*, kept apart from the perceptual
 * thresholds of Requirement 34.
 *
 * Same split as `domain/bgm/bounds.ts`, for the same reason. A target length of
 * 10.5 seconds is not a matter of taste an operator should be able to retune; the
 * 5 % tail-amplitude ceiling of 22.15 is. So counts, ranges and window lengths live
 * here as constants, and the one adjustable number Requirement 22 quotes
 * (`one_shot_tail_amplitude_ratio_max`) is read from the Quality_Threshold_Set in
 * force via `domain/quality/one-shot-tail-thresholds.ts`.
 *
 * The two window lengths — 10 ms for the loop seam (22.14) and 50 ms for the
 * one-shot tail (22.15) — are on the boundary and stay here for the reason
 * `domain/bgm/bounds.ts` gives: they define *what is measured*, and only the ceiling
 * applied to the measurement is adjustable. A set that could move the window would
 * change the meaning of every number already recorded (Requirement 34.10).
 */

/** Requirements 22.2, 22.3: the prompt, before and after tokenisation. */
export const SFX_PROMPT_MIN_LENGTH = 1;
export const SFX_PROMPT_MAX_TOKENS = 77;

/** Requirements 22.4, 22.18. */
export const SFX_TARGET_LENGTH_SECONDS_MIN = 0.1;
export const SFX_TARGET_LENGTH_SECONDS_MAX = 10.0;

/** Requirements 22.5, 22.16, 22.18. 22.16's per-request asset cap is the same 8. */
export const SFX_VARIANT_COUNT_MIN = 1;
export const SFX_VARIANT_COUNT_MAX = 8;

/** Requirement 22.12. */
export const SFX_GUIDANCE_SCALE_MIN = 1.0;
export const SFX_GUIDANCE_SCALE_MAX = 15.0;
export const SFX_GUIDANCE_SCALE_DEFAULT = 7.5;

/** Requirement 22.13: the seed space, inclusive at both ends. */
export const SFX_SEED_MIN = 0;
export const SFX_SEED_MAX = 2_147_483_647;

/** Requirement 22.17: what an unspecified field becomes. */
export const SFX_DEFAULT_TARGET_LENGTH_SECONDS = 2.0;
export const SFX_DEFAULT_VARIANT_COUNT = 4;

/** Requirement 22.7: the normalised alignment score range. */
export const SFX_ALIGNMENT_SCORE_MIN = 0.0;
export const SFX_ALIGNMENT_SCORE_MAX = 1.0;

/**
 * Requirement 22.6: score difference at or below which the seed decides the order.
 *
 * Not a Quality_Threshold_Set member. It is not a perceptual judgement about audio —
 * it is the resolution at which two alignment scores are declared indistinguishable,
 * which is a property of the ordering contract the API publishes. Changing it would
 * change the published order of a result list rather than the admissibility of an
 * asset, so Requirement 34.1's list does not name it and neither does this.
 */
export const SFX_ALIGNMENT_TIE_TOLERANCE = 0.001;

/** Requirement 22.14: the seam window, measured either side of the loop point. */
export const SFX_SEAM_WINDOW_MS = 10;

/** Requirement 22.15: the tail window of a one-shot. */
export const SFX_TAIL_WINDOW_MS = 50;

export function isSfxTargetLengthSeconds(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= SFX_TARGET_LENGTH_SECONDS_MIN &&
    value <= SFX_TARGET_LENGTH_SECONDS_MAX
  );
}

export function isSfxVariantCount(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= SFX_VARIANT_COUNT_MIN &&
    (value as number) <= SFX_VARIANT_COUNT_MAX
  );
}

export function isSfxGuidanceScale(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= SFX_GUIDANCE_SCALE_MIN &&
    value <= SFX_GUIDANCE_SCALE_MAX
  );
}

export function isSfxSeed(value: unknown): boolean {
  return (
    Number.isInteger(value) && (value as number) >= SFX_SEED_MIN && (value as number) <= SFX_SEED_MAX
  );
}
