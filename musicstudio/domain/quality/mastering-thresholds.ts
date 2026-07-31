/**
 * The mastering numbers, projected out of the Quality_Threshold_Set.
 *
 * Requirements 30.6–30.16 quote them as literals — a ±0.5 LUFS target band, a ≤0.1 dB
 * idempotence bound, a ≥10 dB non-speech attenuation, a ±1.0 LUFS speech-loudness bound,
 * a ±10 ms length tolerance, a ±1.0 dB duck accuracy, a ±0.5 dB non-speech hold — and
 * Requirement 34.3 makes every one of them an *initial* value. So nothing under
 * `domain/mastering/`, `services/mastering/` or the DSP worker inlines any of them; they
 * all arrive through this projection, and the worker receives them across the seam.
 *
 * Same shape and same reason as `speech-thresholds.ts` and `v2a-thresholds.ts`: one call
 * yields the values and the version they came from together, so a verdict and the version
 * recorded beside it (Requirement 34.6) cannot come from two different sets. A mastering
 * run must not judge its loudness against version 3 and its length against version 4.
 *
 * Three projections rather than one, because the three operations are separate requests
 * with separate acceptance rules — Requirement 30.6/30.8's normalisation, 30.9/30.10's
 * dialogue cleanup, 30.12/30.16's ducking — and a caller that normalises has no business
 * reading the duck accuracy. `masteringThresholds` composes all three.
 *
 * **The speech-presence pair is not re-declared here.** Requirement 30.12's 100 ms
 * window / −45 dB / 200 ms rule is `speech_detection_rms_threshold_db` and
 * `speech_detection_min_duration_ms`, already in the set and already projected by
 * `speechPresenceThresholds`. Dialogue cleanup and ducking both need exactly that
 * definition of a speech region, so they read that projection rather than introducing a
 * second one. `masteringThresholds` includes it for a caller that wants the whole picture.
 */

import { speechPresenceThresholds, type SpeechPresenceThresholds } from './speech-thresholds';
import { thresholdValue, type QualityThresholdSet } from './threshold-set';

export interface LoudnessNormalizationThresholds {
  /** Requirement 34.6: recorded on every version admitted against these values. */
  readonly version: number;
  /** Requirement 30.6: |achieved − target| ceiling, in LUFS. */
  readonly targetToleranceLufs: number;
  /** Requirement 30.8: |gain₂ − gain₁| ceiling on a re-application, in dB. */
  readonly idempotenceGainDb: number;
}

export function loudnessNormalizationThresholds(
  set: QualityThresholdSet,
): LoudnessNormalizationThresholds {
  return {
    version: set.version,
    targetToleranceLufs: thresholdValue(set, 'loudness_normalization_target_tolerance_lufs'),
    idempotenceGainDb: thresholdValue(set, 'loudness_normalization_idempotence_gain_db'),
  };
}

export interface DialogueCleanupThresholds {
  readonly version: number;
  /** Requirement 30.9: minimum non-speech RMS reduction, in dB. */
  readonly nonSpeechAttenuationMinDb: number;
  /** Requirement 30.9: |speech loudness after − before| ceiling, in LUFS. */
  readonly speechLoudnessToleranceLufs: number;
  /** Requirement 30.10: |output length − input length| ceiling, in ms. */
  readonly lengthToleranceMs: number;
}

export function dialogueCleanupThresholds(set: QualityThresholdSet): DialogueCleanupThresholds {
  return {
    version: set.version,
    nonSpeechAttenuationMinDb: thresholdValue(
      set,
      'dialogue_cleanup_non_speech_attenuation_min_db',
    ),
    speechLoudnessToleranceLufs: thresholdValue(
      set,
      'dialogue_cleanup_speech_loudness_tolerance_lufs',
    ),
    lengthToleranceMs: thresholdValue(set, 'dialogue_cleanup_length_tolerance_ms'),
  };
}

export interface DuckingThresholds {
  readonly version: number;
  /** Requirement 30.12: |achieved duck − requested depth| ceiling, in dB. */
  readonly depthAccuracyDb: number;
  /** Requirement 30.16: |bed level − pre-duck level| ceiling while silent, in dB. */
  readonly nonSpeechHoldDb: number;
}

export function duckingThresholds(set: QualityThresholdSet): DuckingThresholds {
  return {
    version: set.version,
    depthAccuracyDb: thresholdValue(set, 'ducking_depth_accuracy_db'),
    nonSpeechHoldDb: thresholdValue(set, 'ducking_non_speech_hold_db'),
  };
}

/** All of Requirement 30's adjustable numbers at one version. */
export interface MasteringThresholds
  extends LoudnessNormalizationThresholds,
    DialogueCleanupThresholds,
    DuckingThresholds,
    SpeechPresenceThresholds {}

export function masteringThresholds(set: QualityThresholdSet): MasteringThresholds {
  return {
    ...loudnessNormalizationThresholds(set),
    ...dialogueCleanupThresholds(set),
    ...duckingThresholds(set),
    ...speechPresenceThresholds(set),
  };
}
