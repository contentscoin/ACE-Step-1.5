/**
 * What the Speech_Service returns.
 *
 * Split out of `speech-service.ts` for the reason `sfx-result.ts` is split out of
 * `sfx-service.ts`: this is the part with no control flow, so the fields Requirements 25.9, 25.11,
 * 25.14, 25.19 and 25.23 ask for can be read and checked without running a generation.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { DialogueTiming } from '../../domain/speech/line-timing';
import type { DialogueAssetMetadata } from '../../domain/speech/metadata';
import type { ParalinguisticTag } from '../../domain/speech/paralinguistic';
import type { SpeechDefaultableField, SpeechParameters } from '../../domain/speech/request';
import type { TailSilenceVerdict } from '../../domain/speech/tail-silence';
import type { BlockedModeration } from '../moderation/decision';

/** Requirements 25.5, 25.6, 25.10's applied values, echoed as 22.17 does for `sfx`. */
export interface SpeechAppliedDefaults {
  readonly speakingRate: number;
  readonly pitchSemitones: number;
  readonly splitThresholdChars: number;
  readonly defaultedFields: readonly SpeechDefaultableField[];
}

export function speechAppliedDefaults(parameters: SpeechParameters): SpeechAppliedDefaults {
  return {
    speakingRate: parameters.speakingRate,
    pitchSemitones: parameters.pitchSemitones,
    splitThresholdChars: parameters.splitThresholdChars,
    defaultedFields: parameters.appliedDefaults,
  };
}

export interface ProducedDialogue {
  readonly kind: 'produced';
  /** Requirement 25.1: the job that produced the asset. */
  readonly jobId: string;
  readonly assetId: string;
  /** Requirements 25.14, 27.14: the asset's only timing source. */
  readonly timing: DialogueTiming;
  /** Requirements 25.23, 27.14, 34.6. */
  readonly metadata: DialogueAssetMetadata;
  readonly audio: PcmAudio;
  /** Requirement 25.11: how many chunks the script was split into. */
  readonly chunkCount: number;
  /** Requirement 25.13's denominator, echoed so the invariant is checkable by a caller. */
  readonly sentenceCount: number;
  /** Requirement 25.9's 제거된 태그 이름 목록. */
  readonly removedTags: readonly ParalinguisticTag[];
  /** Requirement 25.19's verdict and the adjustment it caused. */
  readonly tailSilence: TailSilenceVerdict;
  readonly applied: SpeechAppliedDefaults;
  /** Requirement 25.18: the base seed — the caller's, or the one drawn. */
  readonly baseSeed: number;
  readonly engineId: string;
}

export type DialogueOutcome =
  | ProducedDialogue
  /**
   * Requirements 16.2, 16.10, 16.11, 16.12, 26.16, 26.17 — refused before anything was charged.
   *
   * Whole-request rather than per-line: the script is inspected as one text (16.10's
   * `dialogue_script` field), so one verdict settles every line and no line is ever submitted.
   */
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };

/** Requirement 25.15's result: the same asset, one line different. */
export interface ResynthesisedDialogue {
  readonly kind: 'resynthesised';
  readonly assetId: string;
  readonly jobId: string;
  readonly lineIndex: number;
  /** False when 25.16's 1 ms threshold was not reached, in which case nothing moved. */
  readonly retimed: boolean;
  /** 재합성 길이 − 재생성 이전 길이, in milliseconds. */
  readonly deltaMs: number;
  readonly timing: DialogueTiming;
  readonly metadata: DialogueAssetMetadata;
  readonly audio: PcmAudio;
  readonly tailSilence: TailSilenceVerdict;
}

export type ResynthesisOutcome =
  | ResynthesisedDialogue
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };
