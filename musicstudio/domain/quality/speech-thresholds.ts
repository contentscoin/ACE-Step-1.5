/**
 * The speech and voice numbers, projected out of the Quality_Threshold_Set.
 *
 * Requirements 25.19, 26.5 and 26.25 quote them as literals — a -60 dBFS silence floor, a
 * 50–200 ms tail window, a -45 dB / 200 ms speech-presence rule, a ±100 ms conversion
 * length tolerance — and Requirement 34.3 makes every one of them an *initial* value. So
 * nothing under `domain/speech/`, `domain/voice/` or `services/speech/` inlines any of
 * them; they all arrive through this projection.
 *
 * Same shape and same reason as `v2a-thresholds.ts`: one call yields the values and the
 * version they came from together, so a verdict and the version recorded beside it
 * (Requirement 34.6) cannot come from two different sets. A dialogue generation that spans
 * several chunks must not judge its tail against version 3 and its length against version 4.
 *
 * Three projections rather than one, because the three judgements are taken at different
 * points and by different code — the tail rule after the chunks are joined, the speech-ratio
 * rule when a reference sample is registered, the length rule when a conversion comes back.
 * `speechThresholds` composes all three for a caller that wants the whole picture.
 *
 * **The speech-presence pair is not new.** `speech_detection_rms_threshold_db` and
 * `speech_detection_min_duration_ms` are Requirement 30.12's members, already in the set.
 * Requirement 26.5's "발화 구간 길이 비율" needs exactly the same definition of a speech
 * region, and the glossary says so ("**발화 구간**: Requirement 30에 정의된 RMS 임계 기준으로
 * 판정된 대사 오디오의 구간"), so 26.5 reads those two rather than introducing a second
 * definition of what speech is.
 */

import { thresholdValue, type QualityThresholdSet } from './threshold-set';

export interface DialogueTailSilenceThresholds {
  /** Requirement 34.6: recorded on every asset admitted against these values. */
  readonly version: number;
  /** Requirement 25.19: at or below this level the tail counts as silence. */
  readonly silenceFloorDbfs: number;
  /** Requirement 25.19: the shortest trailing silence a dialogue asset may keep. */
  readonly tailSilenceMinMs: number;
  /** Requirement 25.19: the longest. */
  readonly tailSilenceMaxMs: number;
}

export function dialogueTailSilenceThresholds(
  set: QualityThresholdSet,
): DialogueTailSilenceThresholds {
  return {
    version: set.version,
    silenceFloorDbfs: thresholdValue(set, 'dialogue_tail_silence_floor_dbfs'),
    tailSilenceMinMs: thresholdValue(set, 'dialogue_tail_silence_min_ms'),
    tailSilenceMaxMs: thresholdValue(set, 'dialogue_tail_silence_max_ms'),
  };
}

export interface SpeechPresenceThresholds {
  readonly version: number;
  /** Requirements 30.12, 26.5: window RMS at or above which a window holds speech. */
  readonly speechRmsThresholdDb: number;
  /** Requirements 30.12, 26.5: shortest run of such windows that counts as speech. */
  readonly speechMinDurationMs: number;
}

export function speechPresenceThresholds(set: QualityThresholdSet): SpeechPresenceThresholds {
  return {
    version: set.version,
    speechRmsThresholdDb: thresholdValue(set, 'speech_detection_rms_threshold_db'),
    speechMinDurationMs: thresholdValue(set, 'speech_detection_min_duration_ms'),
  };
}

export interface VoiceConversionThresholds {
  readonly version: number;
  /** Requirement 26.25: |output length − source length| ceiling, in ms. */
  readonly lengthToleranceMs: number;
}

export function voiceConversionThresholds(set: QualityThresholdSet): VoiceConversionThresholds {
  return {
    version: set.version,
    lengthToleranceMs: thresholdValue(set, 'voice_conversion_length_tolerance_ms'),
  };
}

/** All three projections at one version, for a caller that judges every rule. */
export interface SpeechThresholds
  extends DialogueTailSilenceThresholds,
    SpeechPresenceThresholds,
    VoiceConversionThresholds {}

export function speechThresholds(set: QualityThresholdSet): SpeechThresholds {
  return {
    ...dialogueTailSilenceThresholds(set),
    ...speechPresenceThresholds(set),
    ...voiceConversionThresholds(set),
  };
}
