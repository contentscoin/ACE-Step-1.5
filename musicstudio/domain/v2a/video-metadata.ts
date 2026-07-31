/**
 * What a probe reports about an uploaded video (Requirements 23.2, 23.3).
 *
 * A plain record of measurements, deliberately separate from anything that can decode a
 * file. That separation is the whole point: Requirement 23.2 and 23.3 are seven numeric
 * and enumerated constraints, and stating them over a record makes
 * `domain/v2a/validation.ts` a pure total function that can be exercised at every
 * boundary without an `ffprobe` binary, a temporary file or a codec.
 *
 * **Integration point (task 3.1).** The Python DSP worker produces this record from the
 * real container; `services/sound/v2a-ports.ts` declares the port it arrives through. No
 * media decoding exists in this repository and none is added by this task.
 *
 * `container` is `string` rather than `V2aContainer` on purpose. The probe reports what it
 * found, including formats the product does not accept, and typing it as the accepted
 * union would make the unaccepted case unrepresentable — which is precisely the case
 * Requirement 23.4 legislates for.
 */

export interface ProbedVideoMetadata {
  /** The staged upload this describes, so a rejection can name what to discard. */
  readonly uploadId: string;
  /** Requirement 23.2, normalised to a lower-case short name by the probe. */
  readonly container: string;
  /** Requirement 23.2. */
  readonly videoStreamCount: number;
  /** Requirement 23.2, frames per second. May be fractional (e.g. 23.976). */
  readonly frameRate: number;
  /** Requirement 23.2. The short side is the smaller of the two. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Requirement 23.3, milliseconds. */
  readonly durationMs: number;
  /** Requirement 23.3, bytes. */
  readonly fileSizeBytes: number;
}

/** Requirement 23.2's "짧은 변 해상도". */
export function shortSidePx(metadata: ProbedVideoMetadata): number {
  return Math.min(metadata.widthPx, metadata.heightPx);
}

/**
 * Frames the source holds, derived from its duration and rate.
 *
 * Rounded rather than truncated, and floored at 1: a probe that reports a duration and a
 * rate has described at least one frame, and `domain/v2a/frame-sampling.ts` indexes into
 * this count, so an empty source would make every sampled index out of range.
 */
export function sourceFrameCount(metadata: ProbedVideoMetadata): number {
  return Math.max(1, Math.round((metadata.durationMs * metadata.frameRate) / 1000));
}
