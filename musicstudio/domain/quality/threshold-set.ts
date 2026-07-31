/**
 * Quality_Threshold_Set (Requirements 34.1–34.5).
 *
 * One value object holding every adjustable perceptual threshold plus a single
 * version identifier for the whole set (34.2). Pure: a change produces a *new* set
 * rather than mutating this one, so the "keep prior assets' verdicts unchanged" rule
 * of 34.10 is structural — an asset that recorded version 3 keeps pointing at the
 * value version 3 held.
 *
 * **Ownership.** Task 8.2 owns the operator-facing CRUD: the Audit_Log entry of
 * 34.4, the operator-only permission of 34.9, the calibration record of 34.7 and the
 * failure-rate alert of 34.8. Everything in this module is the part those need to be
 * built on: the shape, the initial values (34.3), the version bump (34.4) and the
 * out-of-range rejection (34.5). Consumers — task 2.4's loop checks, task 2.5's
 * one-shot tail, task 3.3's speech detection — read through `thresholdValue` and
 * record `version` on whatever they admit (34.6).
 */

import {
  QUALITY_THRESHOLD_NAMES,
  type QualityThresholdName,
  type QualityThresholdUnit,
} from './threshold-name';

export interface QualityThreshold {
  readonly name: QualityThresholdName;
  /** Requirement 34.2: the value in force. */
  readonly value: number;
  readonly unit: QualityThresholdUnit;
  /** Requirement 34.2/34.5: inclusive bounds a change may move `value` between. */
  readonly adjustableFrom: number;
  readonly adjustableTo: number;
}

export interface QualityThresholdSet {
  /** Requirement 34.2: one identifier for the whole set, not per threshold. */
  readonly version: number;
  readonly thresholds: Readonly<Record<QualityThresholdName, QualityThreshold>>;
}

/** First version. Requirement 34.4 counts up from here. */
export const INITIAL_QUALITY_THRESHOLD_SET_VERSION = 1;

/**
 * Requirement 34.3: initial values, each transcribed from the requirement that
 * quotes it.
 *
 * The **allowed adjustment ranges are a product decision**, not a transcription:
 * 34.2 requires each threshold to carry one, and no requirement fixes it. Each is
 * chosen so the initial value sits inside it with room to move in the direction
 * 34.8's calibration review would push — looser when a threshold is failing too
 * much, tighter when it admits audible artefacts — while refusing values that would
 * disable the check altogether (a seam RMS ceiling of 40 dB accepts any seam) or
 * make it unsatisfiable (a ceiling of 0 dB accepts only bit-identical edges).
 *
 * **Open question for the spec:** whether these windows should be operator-editable
 * too, or fixed as they are here.
 */
export const INITIAL_QUALITY_THRESHOLD_SET: QualityThresholdSet = {
  version: INITIAL_QUALITY_THRESHOLD_SET_VERSION,
  thresholds: {
    // Requirement 21.7.
    loop_seam_rms_difference_max: {
      name: 'loop_seam_rms_difference_max',
      value: 1.0,
      unit: 'db',
      adjustableFrom: 0.1,
      adjustableTo: 6.0,
    },
    // Requirement 21.8.
    loop_seam_sample_step_ratio_max: {
      name: 'loop_seam_sample_step_ratio_max',
      value: 0.05,
      unit: 'amplitude_ratio',
      adjustableFrom: 0.005,
      adjustableTo: 0.25,
    },
    // Requirement 21.16. Negative because it is a floor *relative to* overall RMS.
    loop_edge_energy_floor: {
      name: 'loop_edge_energy_floor',
      value: -6.0,
      unit: 'db',
      adjustableFrom: -18.0,
      adjustableTo: -1.0,
    },
    // Requirement 21.17 / design §5.3.
    loop_bar_alignment_tolerance_ms: {
      name: 'loop_bar_alignment_tolerance_ms',
      value: 25,
      unit: 'ms',
      adjustableFrom: 5,
      adjustableTo: 100,
    },
    // Requirement 22.15.
    one_shot_tail_amplitude_ratio_max: {
      name: 'one_shot_tail_amplitude_ratio_max',
      value: 0.05,
      unit: 'amplitude_ratio',
      adjustableFrom: 0.005,
      adjustableTo: 0.25,
    },
    // Requirement 24.7.
    sound_pack_loudness_min: {
      name: 'sound_pack_loudness_min',
      value: -25.0,
      unit: 'lufs',
      adjustableFrom: -40.0,
      adjustableTo: -12.0,
    },
    sound_pack_loudness_max: {
      name: 'sound_pack_loudness_max',
      value: -21.0,
      unit: 'lufs',
      adjustableFrom: -36.0,
      adjustableTo: -6.0,
    },
    // Requirement 24.9.
    cue_pair_similarity_max: {
      name: 'cue_pair_similarity_max',
      value: 0.95,
      unit: 'cosine_similarity',
      adjustableFrom: 0.5,
      adjustableTo: 0.999,
    },
    // Requirement 23.8.
    v2a_onset_alignment_tolerance_ms: {
      name: 'v2a_onset_alignment_tolerance_ms',
      value: 80,
      unit: 'ms',
      adjustableFrom: 10,
      adjustableTo: 250,
    },
    v2a_onset_alignment_rate_min: {
      name: 'v2a_onset_alignment_rate_min',
      value: 0.9,
      unit: 'fraction',
      adjustableFrom: 0.5,
      adjustableTo: 1.0,
    },
    // Requirement 30.x.
    speech_detection_rms_threshold_db: {
      name: 'speech_detection_rms_threshold_db',
      value: -45.0,
      unit: 'dbfs',
      adjustableFrom: -70.0,
      adjustableTo: -20.0,
    },
    speech_detection_min_duration_ms: {
      name: 'speech_detection_min_duration_ms',
      value: 200,
      unit: 'ms',
      adjustableFrom: 20,
      adjustableTo: 1_000,
    },
  },
};

/** The value in force. Total: every name in the closed list has an entry. */
export function thresholdValue(set: QualityThresholdSet, name: QualityThresholdName): number {
  return set.thresholds[name].value;
}

export function threshold(
  set: QualityThresholdSet,
  name: QualityThresholdName,
): QualityThreshold {
  return set.thresholds[name];
}

/** Requirement 34.5's rejection: the caller is told the window it missed. */
export interface ThresholdChangeRejected {
  readonly kind: 'rejected';
  readonly name: QualityThresholdName;
  readonly requested: number;
  readonly adjustableFrom: number;
  readonly adjustableTo: number;
}

export interface ThresholdChangeApplied {
  readonly kind: 'applied';
  readonly set: QualityThresholdSet;
  readonly name: QualityThresholdName;
  /** Requirement 34.4: both sides of the change, for the Audit_Log entry. */
  readonly previousValue: number;
  readonly nextValue: number;
  readonly previousVersion: number;
}

export type ThresholdChange = ThresholdChangeApplied | ThresholdChangeRejected;

/**
 * Requirements 34.4 and 34.5 as one pure step.
 *
 * A rejected change returns the existing set untouched (34.5's "기존 값을 유지"), and
 * an applied one bumps the single set version by exactly 1 (34.4) and reports both
 * values so the caller can write the audit entry without re-reading the old set.
 * Writing the entry, checking the operator role and recording the calibration
 * evidence are task 8.2's; none of them belongs in a pure function.
 */
export function changeThreshold(
  set: QualityThresholdSet,
  name: QualityThresholdName,
  value: number,
): ThresholdChange {
  const current = set.thresholds[name];

  if (!Number.isFinite(value) || value < current.adjustableFrom || value > current.adjustableTo) {
    return {
      kind: 'rejected',
      name,
      requested: value,
      adjustableFrom: current.adjustableFrom,
      adjustableTo: current.adjustableTo,
    };
  }

  return {
    kind: 'applied',
    name,
    previousValue: current.value,
    nextValue: value,
    previousVersion: set.version,
    set: {
      version: set.version + 1,
      thresholds: { ...set.thresholds, [name]: { ...current, value } },
    },
  };
}

/** Every threshold, in the declared order. For the operator read of 34.9. */
export function listThresholds(set: QualityThresholdSet): readonly QualityThreshold[] {
  return QUALITY_THRESHOLD_NAMES.map((name) => set.thresholds[name]);
}
