/**
 * The output-length invariant (Requirement 23.9) — the second acceptance criterion of
 * task 2.6.
 *
 * "산출 오디오 길이를 입력 영상 길이 기준 ±40밀리초 이내로 유지한다(불변식)".
 *
 * Written as an *invariant*, which is why this is a predicate over two measured lengths
 * rather than a step in a pipeline: it has to be checkable at any point on any produced
 * asset, including one loaded back out of storage months later, with the version of the
 * tolerance it was admitted against (Requirement 34.6).
 *
 * The tolerance is a Quality_Threshold_Set member (`v2a_output_duration_tolerance_ms`), read
 * through `domain/quality/v2a-thresholds.ts`. It never appears as a literal here.
 *
 * Note where the invariant is *established* rather than merely checked: the segmentation
 * arithmetic of `domain/v2a/segmentation.ts` makes the joined length equal the input length
 * exactly, up to per-segment frame rounding. So this predicate is not a filter that discards
 * most candidates — it is the check that the arithmetic held, which is the only kind of
 * invariant check worth writing.
 */

import type { V2aDurationThresholds } from '../quality/v2a-thresholds';

export interface DurationMeasurement {
  /** Requirement 23.9's reference: the uploaded video's length. */
  readonly inputDurationMs: number;
  /** The joined foley audio's length. */
  readonly outputDurationMs: number;
}

export interface DurationVerdict {
  readonly satisfied: boolean;
  /** `output − input`; positive means the audio overruns the video. */
  readonly errorMs: number;
  readonly toleranceMs: number;
  readonly inputDurationMs: number;
  readonly outputDurationMs: number;
  /** Requirement 34.6. */
  readonly thresholdSetVersion: number;
}

/**
 * Requirement 23.9 over one pair of lengths.
 *
 * A non-finite measurement is a failure rather than an exception: an audio whose length
 * cannot be measured has not been shown to match the video, and the invariant is a claim
 * about evidence.
 */
export function evaluateOutputDuration(
  measurement: DurationMeasurement,
  thresholds: V2aDurationThresholds,
): DurationVerdict {
  const finite =
    Number.isFinite(measurement.inputDurationMs) && Number.isFinite(measurement.outputDurationMs);
  const errorMs = finite
    ? measurement.outputDurationMs - measurement.inputDurationMs
    : Number.POSITIVE_INFINITY;

  return {
    satisfied: finite && Math.abs(errorMs) <= thresholds.outputDurationToleranceMs,
    errorMs,
    toleranceMs: thresholds.outputDurationToleranceMs,
    inputDurationMs: measurement.inputDurationMs,
    outputDurationMs: measurement.outputDurationMs,
    thresholdSetVersion: thresholds.version,
  };
}
