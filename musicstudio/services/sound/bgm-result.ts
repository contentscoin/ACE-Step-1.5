/**
 * What the BGM_Service returns, and how Requirement 21.15's metadata is assembled.
 *
 * Split out of `bgm-service.ts` because it is the only part with no control flow: given
 * a candidate, its measurement and the verdict, the metadata is determined. Keeping it
 * separate means the ten fields of Requirement 21.15 can be checked without running a
 * generation, and the service reads as the sequence of decisions it is.
 */

import { evaluateBarAlignment, type BarAlignment } from '../../domain/bgm/bar-alignment';
import { BGM_INTENSITY_STEP_MIN, BGM_REFERENCE_BPM_TOLERANCE } from '../../domain/bgm/bounds';
import type { LoopMeasurement, LoopSeamVerdict } from '../../domain/bgm/loop-seam';
import {
  compareToReference,
  type BgmAssetMetadata,
  type ReferenceAgreement,
} from '../../domain/bgm/metadata';
import type { BgmParameters, BgmReferenceAsset } from '../../domain/bgm/request';
import type { LoopSeamThresholds } from '../../domain/quality/loop-seam-thresholds';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { BlockedModeration } from '../moderation/decision';

import type { BgmCandidate } from './bgm-ports';

export interface ProducedBgm {
  readonly kind: 'produced';
  readonly jobId: string;
  readonly assetId: string;
  /** Requirement 21.15. */
  readonly metadata: BgmAssetMetadata;
  /** Requirements 21.7/21.8/21.16/21.17. `null` when the request was not a loop. */
  readonly loop: LoopSeamVerdict | null;
  /** Requirement 21.13. `null` when no reference asset was named. */
  readonly reference: ReferenceAgreement | null;
  /** Requirement 21.18: how many attempts it took, 1–3. */
  readonly attempts: number;
}

export type BgmOutcome =
  | ProducedBgm
  /** Requirements 16.2, 16.11 — the content policy refused the request. */
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  /**
   * Requirements 6.1–6.3 — the engine produced nothing.
   *
   * Reported separately from a quality miss because the two are counted separately:
   * see the attempt loop in `bgm-service.ts`.
   */
  | { readonly kind: 'failed'; readonly jobId: string; readonly failure: JobFailure };

export interface BgmMetadataInput {
  readonly candidate: BgmCandidate;
  readonly measurement: LoopMeasurement;
  readonly parameters: BgmParameters;
  readonly thresholds: LoopSeamThresholds;
  readonly verdict: LoopSeamVerdict | null;
  /** Requirement 21.11. 1 for a cue generated without variants. */
  readonly intensityStep?: number;
}

/**
 * Requirement 21.15's ten fields, plus Requirement 21.4's empty lyrics and Requirement
 * 34.6's threshold-set version.
 *
 * The bar count is recorded for a non-loop asset too, because 21.15 lists 마디 수
 * unconditionally. It comes from the same arithmetic the loop criterion uses, so a
 * non-loop cue and a loop cue of the same tempo and length report the same count — the
 * difference between them is whether that count had to be exact, not whether it exists.
 */
export function bgmMetadata(input: BgmMetadataInput): BgmAssetMetadata {
  const alignment: BarAlignment =
    input.verdict?.barAlignment ??
    evaluateBarAlignment({
      durationMs: input.measurement.durationMs,
      bpm: input.candidate.bpm,
      timeSignature: input.candidate.timeSignature,
      toleranceMs: input.thresholds.barAlignmentToleranceMs,
    });

  return {
    bpm: input.candidate.bpm,
    keyScale: input.candidate.keyScale,
    timeSignature: input.candidate.timeSignature,
    intensityStep: input.intensityStep ?? BGM_INTENSITY_STEP_MIN,
    isLoop: input.parameters.loop,
    sampleRate: input.measurement.sampleRate,
    channels: input.measurement.channels.length,
    durationMs: Math.round(input.measurement.durationMs),
    barCount: alignment.barCount,
    integratedLoudnessLufs: input.measurement.integratedLoudnessLufs,
    lyrics: '',
    qualityThresholdSetVersion: input.thresholds.version,
  };
}

/**
 * Requirement 21.13, as a report rather than an enforcement.
 *
 * Requirement 21.12 pins the reference's BPM and key as *generation parameters*, which
 * is the only lever the product layer has: the recorded metadata is whatever the engine
 * reports back. So the agreement is measured and returned, and a caller that cares can
 * act on it.
 *
 * **Integration point (task 3.1).** Independently verifying tempo and key from the
 * produced audio — rather than trusting the engine's own metadata — is analysis the DSP
 * worker will do. Until then this compares reported values.
 */
export function referenceAgreementFor(
  metadata: BgmAssetMetadata,
  reference: BgmReferenceAsset | undefined,
): ReferenceAgreement | null {
  if (reference === undefined) return null;
  return compareToReference(metadata, reference, BGM_REFERENCE_BPM_TOLERANCE);
}
