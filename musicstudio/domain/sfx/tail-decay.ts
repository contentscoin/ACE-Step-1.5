/**
 * One-shot tail decay (Requirement 22.15).
 *
 * "산출된 각 효과음 오디오의 마지막 50밀리초 구간의 최대 절대 진폭을 해당 자산 최대 절대
 * 진폭의 5% 이하로 유지한다" — a sound effect that is not a loop must have finished
 * sounding by the time it ends. An effect still at full level on its last sample clicks
 * when it stops and cannot be placed on a timeline without an edit.
 *
 * Pure predicates over a measurement, exactly like `domain/bgm/loop-seam.ts`, and for the
 * same reason: the rule stays testable against hand-written measurements while the
 * measurement stays testable against synthesised audio, independently. Nothing here reads
 * a sample — `services/sound/in-process-measurement.ts` produces the two numbers per
 * channel that this judges.
 *
 * The ceiling is an argument, never a literal: it is a Quality_Threshold_Set member
 * (Requirement 34.1) and the version it came from is reported in the verdict so whatever
 * admits the asset can record it (Requirement 34.6).
 */

import type { OneShotTailThresholds } from '../quality/one-shot-tail-thresholds';

/** What one channel of a candidate one-shot measures, in linear amplitude. */
export interface ChannelTailMeasurement {
  /** Requirement 22.15: peak absolute amplitude within the last 50 ms. */
  readonly tailPeakAbs: number;
  /** Requirement 22.15's reference: the channel's own peak absolute amplitude. */
  readonly peakAbs: number;
}

export interface TailDecayMeasurement {
  readonly sampleRate: number;
  readonly durationMs: number;
  readonly channels: readonly ChannelTailMeasurement[];
}

/** Per-channel evidence, so a failure says which channel and by how much. */
export interface ChannelTailEvidence {
  readonly channel: number;
  /** `tailPeakAbs / peakAbs`, the quantity Requirement 22.15 bounds. */
  readonly tailRatio: number;
}

export interface TailDecayVerdict {
  readonly satisfied: boolean;
  readonly channels: readonly ChannelTailEvidence[];
  /** The largest ratio across channels; 0 for an asset with no channels. */
  readonly worstTailRatio: number;
  /** Requirement 34.6: the set this ceiling came from. */
  readonly thresholdSetVersion: number;
}

/**
 * Requirement 22.15 over every channel.
 *
 * A conjunction across channels rather than an average, for the reason
 * `evaluateLoopSeam` is: a stereo one-shot whose left channel is cut off mid-sound is a
 * clicking one-shot, however cleanly the right one decayed.
 *
 * An asset with no channels is unsatisfiable rather than vacuously fine — there is
 * nothing to have measured, and reporting "fine" would admit an empty asset.
 */
export function evaluateTailDecay(
  measurement: TailDecayMeasurement,
  thresholds: OneShotTailThresholds,
): TailDecayVerdict {
  const channels = measurement.channels.map(channelEvidence);

  if (channels.length === 0) {
    return {
      satisfied: false,
      channels,
      worstTailRatio: Number.POSITIVE_INFINITY,
      thresholdSetVersion: thresholds.version,
    };
  }

  const worstTailRatio = channels.reduce(
    (worst, evidence) => Math.max(worst, evidence.tailRatio),
    0,
  );

  return {
    // Written as `<=` on the worst channel rather than `!(> )` per channel so the
    // verdict and `worstTailRatio` cannot disagree.
    satisfied: worstTailRatio <= thresholds.tailAmplitudeRatioMax,
    channels,
    worstTailRatio,
    thresholdSetVersion: thresholds.version,
  };
}

function channelEvidence(
  measurement: ChannelTailMeasurement,
  channel: number,
): ChannelTailEvidence {
  return { channel, tailRatio: tailRatio(measurement) };
}

/**
 * Requirement 22.15's ratio.
 *
 * A wholly silent channel has a tail peak of 0 and a peak of 0. Reporting 0 rather than
 * `NaN` is correct on the requirement's own terms — silence has decayed — and it keeps a
 * mono-in-stereo asset whose second channel is empty from failing a rule it cannot
 * violate. A channel whose peak is 0 but whose tail is not is impossible and reported as
 * infinite rather than silently passing.
 */
export function tailRatio(measurement: ChannelTailMeasurement): number {
  if (measurement.peakAbs <= 0) {
    return measurement.tailPeakAbs <= 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return measurement.tailPeakAbs / measurement.peakAbs;
}
