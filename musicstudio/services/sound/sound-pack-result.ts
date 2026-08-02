/**
 * What the Sound_Pack_Service returns.
 *
 * Split out of `sound-pack-service.ts` for the reason `sfx-result.ts` is split out of
 * `sfx-service.ts`: this is the part with no control flow. Given the per-cue outcomes and
 * the three verdicts, the pack's status and its report are determined — so Requirements
 * 24.2, 24.3, 24.21 and 24.22's answers can be checked without running 78 generations, and
 * the service reads as the sequence of decisions it is.
 */

import type { CueLoopSeamVerdict } from '../../domain/sound-pack/loop-seam';
import type { CuePackManifest } from '../../domain/sound-pack/manifest';
import type { CueLoudnessVerdict, PackLoudnessVerdict } from '../../domain/sound-pack/pack-loudness';
import type { CueSimilarityVerdict, CuePairSimilarity } from '../../domain/sound-pack/similarity';
import type { SoundPackStatus } from '../../domain/sound-pack/status';
import type { CueLengthVerdict } from '../../domain/sound-pack/validation';
import type { PackExportVerdict } from '../../domain/sound-pack/export';
import type { CueCategory } from '../../domain/sound-pack/taxonomy';
import type { BlockedModeration } from '../moderation/decision';

/**
 * Requirement 24.21's "실패 원인 구분" — why one cue has no audio.
 *
 * Two kinds, mirroring `SFX_FAILURE_REASONS`, because the same two things can go wrong and
 * they are settled differently:
 *
 * - `engine_failure` — the engine produced nothing for this cue after its retries.
 *   Requirements 6.1–6.3 already refunded that cue's job.
 * - `quality_unmet` — audio arrived and missed Requirement 24.6's seam rule or 24.8's tail
 *   rule, which `SfxService` judges as 22.14/22.15 and refunds through the one refund path.
 *
 * A policy block is not a cue-level reason: the pack's description is shared by all 78
 * generations, so one block refuses the whole request (see `SoundPackOutcome`).
 */
export const PACK_CUE_FAILURE_REASONS = ['engine_failure', 'quality_unmet'] as const;

export type PackCueFailureReason = (typeof PACK_CUE_FAILURE_REASONS)[number];

export interface FailedPackCue {
  readonly cueName: string;
  readonly categoryName: CueCategory;
  /** Requirement 24.21's discriminator. */
  readonly reason: PackCueFailureReason;
  /** Requirement 24.21: attempts made, at most `CUE_GENERATION_ATTEMPTS_MAX`. */
  readonly attempts: number;
  /** The seeds tried, in order, so a failure is reproducible. */
  readonly seeds: readonly number[];
  /** Diagnosis text when the engine gave one. */
  readonly detail: string | null;
}

export interface ProducedPackCue {
  readonly cueName: string;
  readonly categoryName: CueCategory;
  readonly assetId: string;
  readonly jobId: string;
  /** Requirement 24.11's 기본 음량, from the taxonomy. */
  readonly defaultVolume: number;
  readonly loop: boolean;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** The seed the engine used for the attempt that succeeded. */
  readonly seed: number;
  /** How many attempts this cue took, including regenerations under 24.22. */
  readonly attempts: number;
}

/** Requirement 24.22's report for one unresolved pair. */
export interface UnresolvedSimilarPair {
  readonly leftCueName: string;
  readonly rightCueName: string;
  readonly similarity: number;
  /** Requirement 24.22: regenerations attempted for the later cue of the pair. */
  readonly regenerations: number;
}

export interface SoundPackReport {
  readonly kind: 'produced';
  readonly packId: string;
  readonly packName: string;
  readonly status: SoundPackStatus;
  /** Requirement 24.2: 78 when complete, in taxonomy order. */
  readonly cues: readonly ProducedPackCue[];
  /** Requirements 24.3, 24.21: taxonomy names with no audio, in taxonomy order. */
  readonly missingCueNames: readonly string[];
  /** Requirement 24.21: one entry per missing cue, with its cause. */
  readonly failures: readonly FailedPackCue[];
  /** Requirement 24.7. */
  readonly loudness: PackLoudnessVerdict;
  /** Requirements 24.4, 24.5. */
  readonly lengths: readonly CueLengthVerdict[];
  /**
   * Requirement 24.6, for the six loop cues only.
   *
   * Judged by the pack rather than inherited from `SfxService`, because 24.6 names two
   * criteria and Requirement 22.14 names one — see `domain/sound-pack/loop-seam.ts`.
   */
  readonly loopSeams: readonly CueLoopSeamVerdict[];
  /** Requirement 24.9, over every pair. */
  readonly similarity: CueSimilarityVerdict;
  /** Requirement 24.22: pairs still above the ceiling after the reseeded regenerations. */
  readonly unresolvedSimilarPairs: readonly UnresolvedSimilarPair[];
  /** Credits returned by the cue jobs that failed. See `sound-pack-service.ts`. */
  readonly refundedAmount: number;
  /** Requirement 34.6: the set every verdict above was taken against. */
  readonly qualityThresholdSetVersion: number;
}

export type SoundPackOutcome =
  | SoundPackReport
  /**
   * Requirements 16.2, 16.11 — the content policy refused the pack's description.
   *
   * Whole-request rather than per-cue: every cue generation carries the same user text, so
   * one verdict settles all 78, and attempting the rest would charge for audio that cannot
   * be published.
   */
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };

/** What a Requirement 24.17 single-cue regeneration returns. */
export interface CueRegenerationReport {
  readonly kind: 'regenerated';
  readonly packId: string;
  readonly cueName: string;
  /** Absent when the regeneration failed; the pack then keeps its previous audio. */
  readonly cue: ProducedPackCue | null;
  readonly failure: FailedPackCue | null;
  /** Requirement 24.17: the four constraints, re-checked. */
  readonly length: CueLengthVerdict | null;
  readonly loudness: CueLoudnessVerdict | null;
  /** Requirement 24.17's 이음점 제약, re-checked. `null` for a one-shot cue. */
  readonly loopSeam: CueLoopSeamVerdict | null;
  readonly similarity: CueSimilarityVerdict;
  readonly status: SoundPackStatus;
  /** Requirement 24.17: proof the other 77 cues were not touched. */
  readonly unchangedCueCount: number;
  readonly qualityThresholdSetVersion: number;
}

/**
 * A regeneration's outcome.
 *
 * `blocked` is a real possibility rather than a defensive branch: Requirement 24.17's
 * regeneration re-sends the pack's description to the engine, so Requirements 16.2/16.11 apply
 * again — a description that has since been added to the policy vocabulary is refused on the
 * second visit. It is a *union member* rather than a thrown error because the pack survives it
 * unchanged, which is information the caller needs and an exception would obscure.
 */
export type CueRegenerationOutcome =
  | CueRegenerationReport
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };

/** What an export returned (Requirements 24.10, 24.11). */
export interface PackExportOutcome {
  readonly packId: string;
  readonly manifest: CuePackManifest;
  /** The document that went into the archive, byte for byte. */
  readonly manifestDocument: string;
  readonly verdict: PackExportVerdict;
  readonly archiveByteSize: number;
}

/** Requirement 24.22's report shape from a pairwise verdict. */
export function unresolvedPairsOf(
  pairs: readonly CuePairSimilarity[],
  regenerations: number,
): readonly UnresolvedSimilarPair[] {
  return pairs.map((pair) => ({
    leftCueName: pair.leftCueName,
    rightCueName: pair.rightCueName,
    similarity: pair.similarity,
    regenerations,
  }));
}
