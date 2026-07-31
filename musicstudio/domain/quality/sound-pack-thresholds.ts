/**
 * Requirement 24's adjustable numbers, projected out of the Quality_Threshold_Set.
 *
 * Requirement 34.1 already lists the pack loudness window and the cue-pair similarity
 * ceiling as members, and Requirement 34.3 makes the values Requirement 24 quotes their
 * *initial* values — so nothing under `domain/sound-pack/` or `services/sound/` may inline
 * −25 LUFS, −21 LUFS or 0.95. The export budget joins them for the reason
 * `threshold-name.ts` states beside `sound_pack_export_budget_ms`.
 *
 * Same shape and same reason as `one-shot-tail-thresholds.ts`: one call yields the values
 * and the set version they came from together, so a verdict and the version recorded
 * beside it (Requirement 34.6) cannot come from two different sets. The pack is judged
 * against one read, taken once per pack — an operator change landing mid-generation would
 * otherwise judge cue 40 against a different window from cue 39, and Requirement 34.6
 * records one version per asset.
 */

import { thresholdValue, type QualityThresholdSet } from './threshold-set';

export interface SoundPackThresholds {
  /** Requirement 34.6: recorded on every asset admitted against these values. */
  readonly version: number;
  /** Requirement 24.7, LUFS, inclusive at both ends. */
  readonly loudnessMinLufs: number;
  readonly loudnessMaxLufs: number;
  /** Requirement 24.9's ceiling, as a cosine similarity. */
  readonly cuePairSimilarityMax: number;
  /** Requirement 24.10's wall-clock budget, milliseconds. */
  readonly exportBudgetMs: number;
}

export function soundPackThresholds(set: QualityThresholdSet): SoundPackThresholds {
  return {
    version: set.version,
    loudnessMinLufs: thresholdValue(set, 'sound_pack_loudness_min'),
    loudnessMaxLufs: thresholdValue(set, 'sound_pack_loudness_max'),
    cuePairSimilarityMax: thresholdValue(set, 'cue_pair_similarity_max'),
    exportBudgetMs: thresholdValue(set, 'sound_pack_export_budget_ms'),
  };
}

/**
 * Requirement 24.7's window, as its own projection.
 *
 * Split out because the loudness check reads two of the four numbers and nothing else, and
 * a function that took the whole set would let a future edit compare a loudness against
 * the similarity ceiling without the type system objecting.
 */
export interface PackLoudnessThresholds {
  readonly version: number;
  readonly loudnessMinLufs: number;
  readonly loudnessMaxLufs: number;
}

export function packLoudnessThresholds(set: QualityThresholdSet): PackLoudnessThresholds {
  return {
    version: set.version,
    loudnessMinLufs: thresholdValue(set, 'sound_pack_loudness_min'),
    loudnessMaxLufs: thresholdValue(set, 'sound_pack_loudness_max'),
  };
}

/** Requirement 24.9's ceiling on its own. */
export interface CueSimilarityThresholds {
  readonly version: number;
  readonly cuePairSimilarityMax: number;
}

export function cueSimilarityThresholds(set: QualityThresholdSet): CueSimilarityThresholds {
  return {
    version: set.version,
    cuePairSimilarityMax: thresholdValue(set, 'cue_pair_similarity_max'),
  };
}

/** Requirement 24.10's budget on its own. */
export interface PackExportThresholds {
  readonly version: number;
  readonly exportBudgetMs: number;
}

export function packExportThresholds(set: QualityThresholdSet): PackExportThresholds {
  return {
    version: set.version,
    exportBudgetMs: thresholdValue(set, 'sound_pack_export_budget_ms'),
  };
}
