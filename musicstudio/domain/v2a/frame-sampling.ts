/**
 * 24 fps resampling of the source frames (Requirement 23.6).
 *
 * "영상을 초당 24프레임으로 표본화하여 엔진에 전달하고, 원본 프레임률이 초당 24프레임 미만인
 * 경우 직전 프레임을 복제하여 초당 24프레임을 채운다" — the engine always sees 24 frames per
 * second, whatever the source rate was, and a source slower than that is padded by repeating
 * the frame that was showing.
 *
 * This module produces a **plan**, not pixels: a list of source frame indices, one per
 * output frame. That is the whole design decision and it is what makes 23.6 testable here.
 * Decoding frames needs a codec, which this repository does not have and task 3.1 will;
 * *choosing which frame goes where* is arithmetic, and getting it wrong is how foley ends
 * up a frame late. So the arithmetic is a pure function and the pixel-fetching is a port
 * (`V2aFrameSourcePort` in `services/sound/v2a-ports.ts`) that consumes this plan.
 *
 * The mapping is nearest-preceding-frame: output frame `j` shows whatever the source was
 * showing at `j / 24` seconds, i.e. source index `floor(j × sourceFps / 24)`. Two properties
 * follow, and both are asserted:
 *
 * - **It is non-decreasing.** Frames are never reordered, so a sampled clip cannot show
 *   motion running backwards — which would move a visual event's apparent time.
 * - **Duplication happens only downward.** For `sourceFps ≥ 24` consecutive output frames
 *   map to distinct source frames (the step `sourceFps / 24` is at least 1), so 23.6's
 *   "직전 프레임을 복제" clause is reached exactly when its `IF` says it should be.
 *
 * The one exception to the second point is the final-frame clamp, which is reported
 * separately as `clampedCount` rather than hidden inside `duplicatedCount`. A source whose
 * rounded frame count falls a frame short of its duration would otherwise be indexed past
 * its end; clamping to the last frame is the only answer that does not invent a frame, and
 * counting it separately keeps "we duplicated because the source was slow" distinguishable
 * from "we duplicated because the source ran out".
 */

import { V2A_SAMPLE_FRAME_RATE } from './bounds';

export interface FrameSamplingPlan {
  /** Requirement 23.6: always `V2A_SAMPLE_FRAME_RATE`. Stated so a payload can carry it. */
  readonly targetFrameRate: number;
  readonly sourceFrameRate: number;
  /** Source frames available, the value `sourceIndices` is clamped against. */
  readonly sourceFrameCount: number;
  /** One source index per output frame, non-decreasing. */
  readonly sourceIndices: readonly number[];
  /** Requirement 23.6: output frames that repeat their predecessor. */
  readonly duplicatedCount: number;
  /** Output frames whose index was clamped to the last source frame. */
  readonly clampedCount: number;
}

export interface FrameSamplingInput {
  readonly sourceFrameRate: number;
  readonly sourceFrameCount: number;
  readonly durationMs: number;
  /** Injectable only so a test can state the rate it is varying. Defaults to 24. */
  readonly targetFrameRate?: number;
}

/**
 * Requirement 23.6's plan for one clip or one segment.
 *
 * Total: any duration produces at least one output frame, because a segment the engine is
 * asked about must be shown at least one frame, and a plan of length zero would make the
 * segment unconditionable rather than short.
 */
export function planFrameSampling(input: FrameSamplingInput): FrameSamplingPlan {
  const targetFrameRate = input.targetFrameRate ?? V2A_SAMPLE_FRAME_RATE;
  const sourceFrameCount = Math.max(1, Math.floor(input.sourceFrameCount));
  const frameCount = outputFrameCount(input.durationMs, targetFrameRate);

  const sourceIndices: number[] = [];
  let duplicatedCount = 0;
  let clampedCount = 0;

  for (let output = 0; output < frameCount; output += 1) {
    const unclamped = Math.floor((output * input.sourceFrameRate) / targetFrameRate);
    const index = Math.min(Math.max(0, unclamped), sourceFrameCount - 1);
    if (index !== unclamped) clampedCount += 1;
    if (output > 0 && index === sourceIndices[output - 1]) duplicatedCount += 1;
    sourceIndices.push(index);
  }

  return {
    targetFrameRate,
    sourceFrameRate: input.sourceFrameRate,
    sourceFrameCount,
    sourceIndices,
    duplicatedCount,
    clampedCount,
  };
}

/**
 * Output frames for a clip of `durationMs` at `frameRate`.
 *
 * Rounded rather than truncated so a 500 ms clip (Requirement 23.3's floor) gets 12 frames
 * rather than 12 by luck, and floored at 1 for the reason `planFrameSampling` states.
 */
export function outputFrameCount(
  durationMs: number,
  frameRate: number = V2A_SAMPLE_FRAME_RATE,
): number {
  if (!Number.isFinite(durationMs) || !Number.isFinite(frameRate) || frameRate <= 0) return 1;
  return Math.max(1, Math.round((durationMs * frameRate) / 1000));
}

/** The invariant: frames are never reordered (see the module comment). */
export function isNonDecreasing(indices: readonly number[]): boolean {
  for (let index = 1; index < indices.length; index += 1) {
    if ((indices[index] ?? 0) < (indices[index - 1] ?? 0)) return false;
  }
  return true;
}

/**
 * Whether every sampled index addresses a frame that exists.
 *
 * Stated separately from the plan rather than asserted inside it: a plan is data, and a
 * predicate over data is what a property test can quantify over.
 */
export function isWithinSource(plan: FrameSamplingPlan): boolean {
  return plan.sourceIndices.every(
    (index) => Number.isInteger(index) && index >= 0 && index < plan.sourceFrameCount,
  );
}
