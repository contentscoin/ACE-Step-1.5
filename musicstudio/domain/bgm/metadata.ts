/**
 * The metadata a completed background-music asset carries (Requirement 21.15).
 *
 * 21.15 lists ten fields and stops. They are stated here as one required-property
 * type rather than as ten optional additions to `AudioAsset`, so "the metadata was
 * stored" is a type-level fact for a `bgm` asset instead of ten runtime checks — a
 * missing field does not compile.
 *
 * Two fields come from outside 21.15 and are carried anyway:
 *
 * - `lyrics` is Requirement 21.4's second obligation: the produced asset's lyrics
 *   metadata is recorded *empty*. Empty is not the same as absent, and the only way to
 *   assert "recorded as empty" is to record it.
 * - `qualityThresholdSetVersion` is Requirement 34.6. It belongs beside the verdict it
 *   describes, and `AssetProvenance` already has the field it maps onto.
 */

import type { LoopSeamCriterion } from './loop-seam';

export interface BgmAssetMetadata {
  /** Requirement 21.15. */
  readonly bpm: number;
  readonly keyScale: string;
  readonly timeSignature: number;
  /** Requirement 21.11: 1–4. A cue generated without variants records step 1. */
  readonly intensityStep: number;
  /** Requirements 19.10, 21.6. */
  readonly isLoop: boolean;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: number;
  /** Requirement 21.17's whole-bar count. 0 for a non-loop asset. */
  readonly barCount: number;
  readonly integratedLoudnessLufs: number;
  /** Requirement 21.4: recorded empty for every `bgm` asset. */
  readonly lyrics: '';
  /** Requirement 34.6. */
  readonly qualityThresholdSetVersion: number;
}

/** Requirement 21.15's field list, for a test that asserts nothing is dropped. */
export const BGM_METADATA_FIELDS = [
  'bpm',
  'keyScale',
  'timeSignature',
  'intensityStep',
  'isLoop',
  'sampleRate',
  'channels',
  'durationMs',
  'barCount',
  'integratedLoudnessLufs',
] as const;

/**
 * Requirement 21.13: whether a produced asset matches the reference it was pinned to.
 *
 * Separate from the metadata type because it is a *comparison*, and it needs the
 * reference. Reported rather than enforced at this level: the enforcement point is the
 * service, which knows whether a reference was given at all.
 */
export interface ReferenceAgreement {
  readonly bpmWithinTolerance: boolean;
  readonly keyIdentical: boolean;
  readonly bpmDeltaAbsolute: number;
}

export function compareToReference(
  metadata: Pick<BgmAssetMetadata, 'bpm' | 'keyScale'>,
  reference: { readonly bpm: number; readonly keyScale: string },
  bpmTolerance: number,
): ReferenceAgreement {
  const bpmDeltaAbsolute = Math.abs(metadata.bpm - reference.bpm);
  return {
    bpmDeltaAbsolute,
    bpmWithinTolerance: bpmDeltaAbsolute <= bpmTolerance,
    keyIdentical: metadata.keyScale === reference.keyScale,
  };
}

/** Requirement 21.18's response body: the names of the criteria that were not met. */
export interface BgmLoopQualityFailure {
  readonly unmet: readonly LoopSeamCriterion[];
  /** Attempts spent, always `BGM_LOOP_QUALITY_MAX_ATTEMPTS` when this is returned. */
  readonly attempts: number;
  /** Requirement 21.18: the credits returned, so the caller can reconcile. */
  readonly refundedAmount: number;
}
