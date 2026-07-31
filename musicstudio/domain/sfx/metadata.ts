/**
 * What Requirement 22 records on a produced `sfx` Audio_Asset.
 *
 * 22.1 lists four fields — 프롬프트, 목표 길이, 루프 자산 여부, 모델 등급 — 22.7 adds the
 * normalised alignment score and 22.13 adds the seed. Requirement 34.6 adds the version of
 * the Quality_Threshold_Set the asset was admitted against, exactly as `bgm` assets record
 * it.
 *
 * Assembled by a pure function for the reason `domain/bgm/metadata.ts` and
 * `services/sound/bgm-result.ts` split the same way: given the candidate and its
 * measurements the metadata is determined, so the six-or-seven fields can be checked
 * without running a generation.
 */

import type { SfxModelTier } from './model-tier';

export interface SfxAssetMetadata {
  /** Requirement 22.1: the prompt actually submitted, trimmed. */
  readonly prompt: string;
  /** Requirement 22.1: 목표 길이, as requested, in seconds. */
  readonly targetLengthSeconds: number;
  /** Requirement 22.1. */
  readonly isLoop: boolean;
  /** Requirement 22.1. */
  readonly modelTier: SfxModelTier;
  /** Requirement 22.7: normalised into `[0, 1]`. */
  readonly alignmentScore: number;
  /** Requirement 22.13: the seed this variant actually used. */
  readonly seed: number;
  /** Requirements 22.10–22.12, recorded so 22.8 can be re-requested exactly. */
  readonly samplingSteps: number;
  readonly guidanceScale: number;
  /** Produced length, which may differ from the target. */
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirement 34.6. */
  readonly qualityThresholdSetVersion: number;
}
