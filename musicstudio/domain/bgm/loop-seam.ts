/**
 * Loop seam continuity (Requirements 21.6, 21.7, 21.8, 21.16, 21.17; design §5.3).
 *
 * Four independent judgements about one asset, and this module is all four as pure
 * predicates over a measurement. It computes nothing from audio itself: the numbers
 * arrive already measured (`services/sound/measurement.ts` produces them, from PCM
 * now and from the task 3.1 worker later), so the *rules* stay testable against
 * hand-written measurements and the *measurement* stays testable against synthesised
 * audio, independently.
 *
 * The seam is defined once, in Requirement 21.7, and every check inherits it: the loop
 * point is where the last sample meets the first. So "tail" always means the end of
 * the buffer and "head" always means its start, and there is no second convention for
 * a fade or a crossfade to disagree with.
 *
 * Thresholds are arguments, never literals — they are Quality_Threshold_Set members
 * (Requirement 34.1) and the version they came from is reported back in the verdict so
 * whatever admits the asset can record it (Requirement 34.6).
 */

import { amplitudeDifferenceDb, amplitudeToDb } from '../audio/level';
import type { LoopSeamThresholds } from '../quality/loop-seam-thresholds';

import { evaluateBarAlignment, type BarAlignment } from './bar-alignment';

/**
 * What one channel of a candidate loop measures, in linear amplitude.
 *
 * Linear rather than dB throughout because two of the four rules are ratios and one
 * is a difference of levels: keeping amplitudes lets a silent window be 0 instead of
 * `-Infinity`, and `0 − 0` is a well-defined absence of difference where
 * `-Infinity − (-Infinity)` is `NaN`.
 */
export interface ChannelLoopMeasurement {
  /** Requirement 21.7: RMS of the first 10 ms. */
  readonly headSeamRms: number;
  /** Requirement 21.7: RMS of the last 10 ms. */
  readonly tailSeamRms: number;
  /** Requirement 21.16: RMS of the first 100 ms. */
  readonly headEdgeRms: number;
  /** Requirement 21.16: RMS of the last 100 ms. */
  readonly tailEdgeRms: number;
  /** Requirement 21.16's reference: RMS of the whole channel. */
  readonly overallRms: number;
  /** Requirement 21.8. */
  readonly firstSample: number;
  readonly lastSample: number;
  /** Requirement 21.8's reference: the channel's own peak absolute amplitude. */
  readonly peakAbs: number;
}

export interface LoopMeasurement {
  readonly sampleRate: number;
  readonly channels: readonly ChannelLoopMeasurement[];
  readonly durationMs: number;
  /** Requirement 21.17 computes the bar from the asset's recorded tempo. */
  readonly bpm: number;
  readonly timeSignature: number;
  /** Requirement 21.15. Not itself a loop criterion; carried so metadata is complete. */
  readonly integratedLoudnessLufs: number;
}

/**
 * The four criterion names Requirement 21.18 returns on failure.
 *
 * Machine-readable identifiers rather than prose, because 21.18 says "미충족 기준 이름
 * 목록" and the list crosses an API boundary; `criterionRequirement` maps each to the
 * criterion it enforces so a client can cite the requirement without a lookup table of
 * its own.
 */
export const LOOP_SEAM_CRITERIA = [
  'seam_rms_difference',
  'seam_sample_step',
  'edge_energy',
  'bar_alignment',
] as const;

export type LoopSeamCriterion = (typeof LOOP_SEAM_CRITERIA)[number];

export const CRITERION_REQUIREMENT: Readonly<Record<LoopSeamCriterion, string>> = {
  seam_rms_difference: '21.7',
  seam_sample_step: '21.8',
  edge_energy: '21.16',
  bar_alignment: '21.17',
};

/** Per-channel evidence, so a failure says *which* channel and by how much. */
export interface ChannelLoopEvidence {
  readonly channel: number;
  /** Requirement 21.7, dB. */
  readonly seamRmsDifferenceDb: number;
  /** Requirement 21.8, as a fraction of the channel's peak. */
  readonly seamSampleStepRatio: number;
  /** Requirement 21.16, dB relative to the channel's overall RMS. */
  readonly headEdgeRelativeDb: number;
  readonly tailEdgeRelativeDb: number;
}

export interface LoopSeamVerdict {
  readonly satisfied: boolean;
  /** Requirement 21.18's list. Empty exactly when `satisfied`. */
  readonly unmet: readonly LoopSeamCriterion[];
  readonly channels: readonly ChannelLoopEvidence[];
  readonly barAlignment: BarAlignment;
  /** Requirement 34.6: the set these thresholds came from. */
  readonly thresholdSetVersion: number;
}

/**
 * All four criteria, over every channel.
 *
 * Requirements 21.7, 21.8 and 21.16 each say "모든 채널에서" or "각 채널에서", so a
 * criterion fails when *any* channel fails it — the verdict is a conjunction across
 * channels, not an average. A stereo loop whose left channel clicks is a clicking loop.
 *
 * An asset with no channels is unsatisfiable rather than vacuously satisfied: there is
 * nothing to have measured, and reporting "fine" would admit an empty asset.
 */
export function evaluateLoopSeam(
  measurement: LoopMeasurement,
  thresholds: LoopSeamThresholds,
): LoopSeamVerdict {
  const barAlignment = evaluateBarAlignment({
    durationMs: measurement.durationMs,
    bpm: measurement.bpm,
    timeSignature: measurement.timeSignature,
    toleranceMs: thresholds.barAlignmentToleranceMs,
  });

  const channels = measurement.channels.map(channelEvidence);
  const unmet: LoopSeamCriterion[] = [];

  if (channels.length === 0) {
    return {
      satisfied: false,
      unmet: [...LOOP_SEAM_CRITERIA],
      channels,
      barAlignment,
      thresholdSetVersion: thresholds.version,
    };
  }

  if (
    channels.some(
      (evidence) => !(evidence.seamRmsDifferenceDb <= thresholds.seamRmsDifferenceMaxDb),
    )
  ) {
    unmet.push('seam_rms_difference');
  }

  if (
    channels.some((evidence) => !(evidence.seamSampleStepRatio <= thresholds.seamSampleStepRatioMax))
  ) {
    unmet.push('seam_sample_step');
  }

  if (
    channels.some(
      (evidence) =>
        !(evidence.headEdgeRelativeDb >= thresholds.edgeEnergyFloorDb) ||
        !(evidence.tailEdgeRelativeDb >= thresholds.edgeEnergyFloorDb),
    )
  ) {
    unmet.push('edge_energy');
  }

  if (!barAlignment.aligned) unmet.push('bar_alignment');

  return {
    satisfied: unmet.length === 0,
    unmet,
    channels,
    barAlignment,
    thresholdSetVersion: thresholds.version,
  };
}

function channelEvidence(
  measurement: ChannelLoopMeasurement,
  channel: number,
): ChannelLoopEvidence {
  return {
    channel,
    seamRmsDifferenceDb: amplitudeDifferenceDb(measurement.tailSeamRms, measurement.headSeamRms),
    seamSampleStepRatio: sampleStepRatio(measurement),
    headEdgeRelativeDb: relativeDb(measurement.headEdgeRms, measurement.overallRms),
    tailEdgeRelativeDb: relativeDb(measurement.tailEdgeRms, measurement.overallRms),
  };
}

/**
 * Requirement 21.8: the discontinuity, as a fraction of the channel's peak.
 *
 * A wholly silent channel has a step of 0 and a peak of 0. Reporting 0 rather than
 * `NaN` is correct on the requirement's own terms — there is no discontinuity in
 * silence — and it keeps a mono-in-stereo asset whose second channel is empty from
 * failing a criterion it cannot violate.
 */
function sampleStepRatio(measurement: ChannelLoopMeasurement): number {
  const step = Math.abs(measurement.lastSample - measurement.firstSample);
  if (measurement.peakAbs <= 0) return step === 0 ? 0 : Number.POSITIVE_INFINITY;
  return step / measurement.peakAbs;
}

/** Requirement 21.16: an edge window's level relative to the whole channel, in dB. */
function relativeDb(edgeRms: number, overallRms: number): number {
  if (overallRms <= 0) return edgeRms <= 0 ? 0 : Number.POSITIVE_INFINITY;
  if (edgeRms <= 0) return Number.NEGATIVE_INFINITY;
  return amplitudeToDb(edgeRms) - amplitudeToDb(overallRms);
}

/** Requirement 21.18's payload: the unmet names with the criteria they enforce. */
export function describeUnmetCriteria(
  unmet: readonly LoopSeamCriterion[],
): readonly { readonly criterion: LoopSeamCriterion; readonly requirement: string }[] {
  return unmet.map((criterion) => ({ criterion, requirement: CRITERION_REQUIREMENT[criterion] }));
}
