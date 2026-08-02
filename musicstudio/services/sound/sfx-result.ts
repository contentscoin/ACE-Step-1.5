/**
 * What the SFX_Service returns, and how Requirement 22's metadata is assembled.
 *
 * Split out of `sfx-service.ts` for the reason `bgm-result.ts` is split out of
 * `bgm-service.ts`: this is the part with no control flow. Given a candidate, its
 * measurements and the verdicts, the metadata and the failure classification are
 * determined — so the fields of 22.1, 22.7 and 22.13 can be checked without running a
 * generation, and the service reads as the sequence of decisions it is.
 */

import { normalizeAlignmentScore } from '../../domain/sfx/alignment';
import type { SfxAssetMetadata } from '../../domain/sfx/metadata';
import type { SfxParameters } from '../../domain/sfx/request';
import type { TailDecayVerdict } from '../../domain/sfx/tail-decay';
import type { LoopSeamVerdict } from '../../domain/bgm/loop-seam';
import type { AudioShape } from './measurement';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { BlockedModeration } from '../moderation/decision';

import type { SfxCandidate } from './sfx-ports';

/**
 * The quality criteria a produced variant is judged on.
 *
 * Two names, and exactly one of them applies to any given variant: `loop_seam` for a loop
 * (22.14) and `one_shot_tail` for a one-shot (22.15). Machine-readable identifiers rather
 * than prose because they cross an API boundary as Requirement 22.19's "실패 사유 구분값".
 */
export const SFX_QUALITY_CRITERIA = ['loop_seam', 'one_shot_tail'] as const;

export type SfxQualityCriterion = (typeof SFX_QUALITY_CRITERIA)[number];

export const SFX_QUALITY_CRITERION_REQUIREMENT: Readonly<Record<SfxQualityCriterion, string>> = {
  loop_seam: '22.14',
  one_shot_tail: '22.15',
};

/**
 * Requirement 22.19's "실패 사유 구분값" — why one variant of a request did not survive.
 *
 * Three kinds, because three genuinely different things can go wrong and 22.19 asks for a
 * discriminator rather than a message:
 *
 * - `engine_failure` — the engine produced no audio. Requirements 6.1–6.3 already refunded it.
 * - `quality_unmet` — audio arrived and missed 22.14 or 22.15. Refunded here.
 * - `blocked` never appears: a policy block applies to the prompt, which every variant shares,
 *   so it refuses the whole request rather than one variant (see `SfxOutcome`).
 */
export const SFX_FAILURE_REASONS = ['engine_failure', 'quality_unmet'] as const;

export type SfxFailureReason = (typeof SFX_FAILURE_REASONS)[number];

export interface FailedSfxVariant {
  readonly seed: number;
  readonly jobId: string | null;
  /** Requirement 22.19. */
  readonly reason: SfxFailureReason;
  /** Present for `quality_unmet`. */
  readonly unmet: readonly SfxQualityCriterion[];
  /** Present for `engine_failure`. */
  readonly failure: JobFailure | null;
}

export interface ProducedSfxVariant {
  readonly jobId: string;
  readonly assetId: string;
  /** Requirements 22.1, 22.7, 22.13. */
  readonly metadata: SfxAssetMetadata;
  /** Requirement 22.7, hoisted for the ranking of 22.6. */
  readonly alignmentScore: number;
  /** Requirement 22.13. */
  readonly seed: number;
  /** Requirement 22.14's verdict; `null` when the variant is not a loop. */
  readonly loopSeam: LoopSeamVerdict | null;
  /** Requirement 22.15's verdict; `null` when the variant is a loop. */
  readonly tailDecay: TailDecayVerdict | null;
}

export interface ProducedSfxSet {
  readonly kind: 'produced';
  /**
   * Requirement 22.6: score descending, seed ascending inside a near-tie run.
   *
   * At most 8 entries (22.16), at least 1 — an empty set is never `produced`.
   */
  readonly variants: readonly ProducedSfxVariant[];
  /** Requirement 22.19: the variants that did not survive, in submission order. */
  readonly failures: readonly FailedSfxVariant[];
  /** Requirement 22.19: credits returned for the failed variants. */
  readonly refundedAmount: number;
  /** Requirement 22.17: the values the service supplied, echoed to the caller. */
  readonly applied: SfxAppliedDefaults;
  /** The base seed of the request — the caller's, or the one drawn per 22.13. */
  readonly baseSeed: number;
  readonly engineId: string;
}

/** Requirement 22.17: the resolved values, with the list of which were defaulted. */
export interface SfxAppliedDefaults {
  readonly targetLengthSeconds: number;
  readonly variantCount: number;
  readonly modelTier: SfxParameters['modelTier'];
  readonly samplingSteps: number;
  readonly guidanceScale: number;
  readonly defaultedFields: readonly SfxParameters['appliedDefaults'][number][];
}

export type SfxOutcome =
  | ProducedSfxSet
  /**
   * Requirements 16.2, 16.11 — the content policy refused the prompt.
   *
   * Whole-request rather than per-variant: every variant carries the same user text, so one
   * verdict settles all of them, and attempting the rest would charge for audio that cannot
   * be published.
   */
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };

export function appliedDefaultsOf(parameters: SfxParameters): SfxAppliedDefaults {
  return {
    targetLengthSeconds: parameters.targetLengthSeconds,
    variantCount: parameters.variantCount,
    modelTier: parameters.modelTier,
    samplingSteps: parameters.samplingSteps,
    guidanceScale: parameters.guidanceScale,
    defaultedFields: parameters.appliedDefaults,
  };
}

export interface SfxMetadataInput {
  readonly candidate: SfxCandidate;
  readonly parameters: SfxParameters;
  readonly shape: AudioShape;
  /** Requirement 34.6: the set the verdict was taken against. */
  readonly qualityThresholdSetVersion: number;
}

/**
 * Requirement 22.1's four fields, plus 22.7's score, 22.13's seed and 34.6's version.
 *
 * The alignment score is normalised here and only here, so there is one place a score can
 * enter storage and it is the place that clamps it into `[0, 1]`. A candidate the engine did
 * not score becomes `SFX_UNSCORED_ALIGNMENT`: it ranks last (22.6 orders by score, and the
 * floor is the lowest score there is) and is still stored and still usable, which is the
 * right outcome for audio the user paid for and can hear.
 */
export function sfxMetadata(input: SfxMetadataInput): SfxAssetMetadata {
  return {
    prompt: input.parameters.prompt,
    targetLengthSeconds: input.parameters.targetLengthSeconds,
    isLoop: input.parameters.loop,
    modelTier: input.parameters.modelTier,
    alignmentScore: normalizeAlignmentScore(
      input.candidate.alignmentScore ?? SFX_UNSCORED_ALIGNMENT,
    ),
    seed: input.candidate.seed,
    samplingSteps: input.parameters.samplingSteps,
    guidanceScale: input.parameters.guidanceScale,
    durationMs: Math.round(input.shape.durationMs),
    sampleRate: input.shape.sampleRate,
    channels: input.shape.channels,
    qualityThresholdSetVersion: input.qualityThresholdSetVersion,
  };
}

/**
 * Score recorded for a candidate the engine did not score.
 *
 * The floor rather than a midpoint or a sentinel: Requirement 22.7 fixes the range at
 * `[0, 1]` with no room for "unknown", and 22.6 sorts by the score — so an unscored candidate
 * has to be *somewhere* in the order, and last is the only defensible place. A midpoint would
 * rank an unmeasured candidate above measured ones that scored below it.
 *
 * **Open question for the spec:** whether an engine that reports no alignment score should be
 * usable for `sfx` at all, given 22.6 and 22.7 both assume one exists.
 */
export const SFX_UNSCORED_ALIGNMENT = 0;
