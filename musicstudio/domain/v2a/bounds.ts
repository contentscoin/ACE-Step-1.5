/**
 * Bounds Requirement 23 states as *structure*, kept apart from the perceptual
 * thresholds of Requirement 34.
 *
 * The same split as `domain/sfx/bounds.ts` and `domain/bgm/bounds.ts`, applied to the
 * numbers of Requirement 23. Two questions decide which side a number falls on:
 *
 * - *Would changing it change what a recorded measurement means?* If yes it is a
 *   constant, because Requirement 34.10 keeps prior assets' verdicts fixed and a
 *   verdict whose measurement had silently been redefined is not the same verdict.
 *   The 5 ms onset frame and the 50 ms lookback (23.8) are of this kind: they define
 *   the RMS that the 6.0 dB rise is a rise *of*.
 * - *Would changing it change only which audio is admissible?* Then it belongs to the
 *   Quality_Threshold_Set — see `domain/quality/v2a-thresholds.ts`, which owns the
 *   6.0 dB rise, the 0.50 confidence floor, the ±80 ms window, the 90 % rate, the
 *   ±20 ms preview offset and the ±40 ms duration error.
 *
 * The container list, the duration and size limits, the frame-rate window and the
 * resolution floor (23.2, 23.3) are constants for a third reason: they are the shape of
 * an *input the system can process at all*, not a judgement about output quality. A
 * deployment that can decode a 300 MB file has a different decoder, not a different
 * calibration.
 */

/**
 * Requirement 23.2: the accepted container formats.
 *
 * Matched case-insensitively on a normalised short name (`mp4`, `mov`, `webm`) rather
 * than on a MIME type or a file extension, because a probe reports the container it
 * actually found and that is the only claim worth validating — an `.mp4` extension on a
 * Matroska file is exactly the case 23.4 exists to refuse.
 */
export const V2A_CONTAINERS = ['mp4', 'mov', 'webm'] as const;

export type V2aContainer = (typeof V2A_CONTAINERS)[number];

/** Requirement 23.2: at least one video stream. */
export const V2A_VIDEO_STREAM_COUNT_MIN = 1;

/** Requirement 23.2, frames per second, inclusive at both ends. */
export const V2A_FRAME_RATE_MIN = 8;
export const V2A_FRAME_RATE_MAX = 120;

/** Requirement 23.2: the *short* side, in pixels. */
export const V2A_SHORT_SIDE_MIN_PX = 128;

/** Requirement 23.3, milliseconds. */
export const V2A_DURATION_MS_MIN = 500;
export const V2A_DURATION_MS_MAX = 60_000;

/** Requirement 23.3, bytes. 200 MB as the decimal megabyte the requirement means. */
export const V2A_FILE_SIZE_BYTES_MAX = 200 * 1_000_000;

/** Requirement 23.6: the rate the engine is fed, regardless of the source rate. */
export const V2A_SAMPLE_FRAME_RATE = 24;

/** Requirement 23.7: the engine's maximum processing window, milliseconds. */
export const V2A_SEGMENT_MAX_MS = 8_000;

/** Requirement 23.7: how much adjacent segments overlap, milliseconds. */
export const V2A_SEGMENT_OVERLAP_MS = 50;

/**
 * Requirement 23.8: the frame the short-term RMS is computed over, milliseconds.
 *
 * A constant, not a threshold. See the module comment.
 */
export const V2A_ONSET_FRAME_MS = 5;

/** Requirement 23.8: how far back the comparison average reaches, milliseconds. */
export const V2A_ONSET_LOOKBACK_MS = 50;

/** Requirement 23.1: assets produced by one foley Generation_Job. */
export const V2A_VARIANT_COUNT_MIN = 1;
export const V2A_VARIANT_COUNT_MAX = 4;

/** Requirement 23.1's default when the caller names no count. */
export const V2A_DEFAULT_VARIANT_COUNT = 1;

/** Requirement 23.15: the confidence a visual event reports, inclusive. */
export const V2A_CONFIDENCE_MIN = 0.0;
export const V2A_CONFIDENCE_MAX = 1.0;

/**
 * Requirement 23.5: the optional text prompt.
 *
 * No upper bound is stated by Requirement 23, and none is invented here. The prompt is
 * forwarded to the engine, which applies its own limit — for the Woosh engines that is
 * Requirement 22.3's 77 tokens, enforced by `domain/sfx/validation.ts`, and duplicating
 * a second limit at this layer would give the same prompt two different verdicts
 * depending on which service received it.
 */
export const V2A_PROMPT_MIN_LENGTH = 1;

export function isV2aContainer(value: unknown): value is V2aContainer {
  return typeof value === 'string' && (V2A_CONTAINERS as readonly string[]).includes(value);
}

export function isV2aVariantCount(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= V2A_VARIANT_COUNT_MIN &&
    (value as number) <= V2A_VARIANT_COUNT_MAX
  );
}

export function isV2aConfidence(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= V2A_CONFIDENCE_MIN &&
    value <= V2A_CONFIDENCE_MAX
  );
}

/**
 * How far each segment advances past the previous one, milliseconds.
 *
 * Derived rather than declared, so the two numbers it is derived from cannot drift apart
 * from it. Positive by construction: the overlap is two orders of magnitude below the
 * segment length, and a configuration where it were not would make segmentation
 * non-terminating rather than merely wrong.
 */
export const V2A_SEGMENT_ADVANCE_MS = V2A_SEGMENT_MAX_MS - V2A_SEGMENT_OVERLAP_MS;
