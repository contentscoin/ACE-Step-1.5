/**
 * What Requirements 25 and 27 record on a produced `dialogue` Audio_Asset.
 *
 * 25.23 requires the Voice_Profile identifier as 출처 정보 — the single field the criterion
 * exists for. 27.14 requires the confirmed script line boundaries to be stored and to be *the*
 * timing source for the asset, which is why the timing travels on the metadata rather than in a
 * side table: a caller holding the asset holds its timings, and there is no second place a
 * different set of boundaries could come from.
 *
 * 25.9's removed tag names, 25.18's seed and the parameters the seed is only meaningful
 * alongside are recorded too, so a re-request under 25.18 can be reconstructed exactly and a
 * re-synthesis under 25.15 can reuse the same values without the caller resupplying them.
 * Requirement 34.6 adds the Quality_Threshold_Set version the 25.19 tail verdict was taken
 * against.
 *
 * Assembled by a pure function, for the reason `domain/sfx/metadata.ts` gives: given the timing
 * and the measurements the metadata is determined, so the fields can be checked without running
 * a generation.
 */

import type { DialogueTiming } from './line-timing';
import type { ParalinguisticTag } from './paralinguistic';
import type { SpeechParameters } from './request';

export interface DialogueAssetMetadata {
  /** Requirement 25.23 — 생성에 사용된 Voice_Profile 식별자. */
  readonly voiceProfileId: string;
  /** The engine routing actually chose, which 25.15 and 25.18 both have to reuse. */
  readonly engineId: string;
  /** The script as submitted, trimmed. Requirement 25.18's key reads this. */
  readonly script: string;
  readonly languageCode: string;
  readonly speakingRate: number;
  readonly pitchSemitones: number;
  readonly actingInstruction: string | null;
  /** Requirement 25.9. Empty when the engine kept every tag, or there were none. */
  readonly removedTags: readonly ParalinguisticTag[];
  /** Requirement 25.18: the seed this asset actually used. */
  readonly seed: number;
  /** Requirement 25.10: the threshold in force, so 25.15 can reuse the whole parameter set. */
  readonly splitThresholdChars: number;
  /** Requirement 25.11: how many chunks the script was split into. */
  readonly chunkCount: number;
  /** Requirements 25.14, 27.14: the asset's only timing source. */
  readonly timing: DialogueTiming;
  /** Overlap consumed at each line seam, so 25.15 can re-derive the layout. */
  readonly seamOverlapsMs: readonly number[];
  /** Requirement 25.19's measured trailing silence, after adjustment. */
  readonly trailingSilenceMs: number;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirement 34.6. */
  readonly qualityThresholdSetVersion: number;
}

export interface DialogueMetadataInput {
  readonly parameters: SpeechParameters;
  readonly voiceProfileId: string;
  readonly engineId: string;
  readonly seed: number;
  readonly chunkCount: number;
  readonly timing: DialogueTiming;
  readonly seamOverlapsMs: readonly number[];
  readonly trailingSilenceMs: number;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly qualityThresholdSetVersion: number;
}

export function dialogueMetadata(input: DialogueMetadataInput): DialogueAssetMetadata {
  return {
    voiceProfileId: input.voiceProfileId,
    engineId: input.engineId,
    script: input.parameters.originalScript,
    languageCode: input.parameters.languageCode,
    speakingRate: input.parameters.speakingRate,
    pitchSemitones: input.parameters.pitchSemitones,
    actingInstruction: input.parameters.actingInstruction,
    removedTags: input.parameters.removedTags,
    seed: input.seed,
    splitThresholdChars: input.parameters.splitThresholdChars,
    chunkCount: input.chunkCount,
    timing: input.timing,
    seamOverlapsMs: [...input.seamOverlapsMs],
    trailingSilenceMs: Math.round(input.trailingSilenceMs),
    durationMs: Math.round(input.durationMs),
    sampleRate: input.sampleRate,
    channels: input.channels,
    qualityThresholdSetVersion: input.qualityThresholdSetVersion,
  };
}
