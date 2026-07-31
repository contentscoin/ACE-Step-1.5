import { describe, expect, it } from 'vitest';

import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import {
  dialogueTailSilenceThresholds,
  speechPresenceThresholds,
  voiceConversionThresholds,
} from '../../../domain/quality/speech-thresholds';
import {
  QUALITY_THRESHOLD_NAMES,
  QUALITY_THRESHOLD_UNITS,
  isQualityThresholdName,
} from '../../../domain/quality/threshold-name';
import { fixedThresholdSource } from '../../../domain/quality/threshold-source';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  INITIAL_QUALITY_THRESHOLD_SET_VERSION,
  changeThreshold,
  listThresholds,
  threshold,
  thresholdValue,
} from '../../../domain/quality/threshold-set';

/**
 * Quality_Threshold_Set — the shape task 8.2's operator CRUD will be built on.
 *
 * **Validates: Requirements 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.10**
 *
 * Scope note. This task owns the *value object*: the membership of 34.1, the per-threshold
 * fields of 34.2, the initial values of 34.3, the version bump of 34.4, the out-of-range
 * rejection of 34.5, and the read seam that lets a consumer record a version (34.6).
 * **Task 8.2 owns everything around it** — the Audit_Log entry text of 34.4, the
 * operator-only permission of 34.9, the calibration evidence of 34.7 and the failure-rate
 * alert of 34.8 — so none of those is asserted here.
 *
 * The tests that matter most are the 34.3 transcriptions: they are what stop Requirement
 * 21's numbers being quietly reinterpreted, since every loop check reads them from here.
 */

describe('membership (Requirement 34.1)', () => {
  it('holds every threshold 34.1 enumerates', () => {
    // 34.1's items, with the pack loudness range counted as its two bounds (34.2
    // gives each threshold exactly one value) and bar-alignment tolerance included as
    // the fourth co-equal loop criterion of Requirement 21.6. The six `v2a_*` members
    // are Requirement 23's numbers, added by task 2.6 for the reason
    // `domain/quality/v2a-thresholds.ts` states: 23.8/23.9/23.12 quote them as initial
    // values, so nothing under `domain/v2a/` may inline them. The three
    // `dialogue_tail_silence_*` members and `voice_conversion_length_tolerance_ms` are
    // Requirements 25.19 and 26.25's numbers, added by task 2.7 for the same reason —
    // see `domain/quality/speech-thresholds.ts`.
    expect(QUALITY_THRESHOLD_NAMES).toEqual([
      'loop_seam_rms_difference_max',
      'loop_seam_sample_step_ratio_max',
      'loop_edge_energy_floor',
      'loop_bar_alignment_tolerance_ms',
      'one_shot_tail_amplitude_ratio_max',
      'sound_pack_loudness_min',
      'sound_pack_loudness_max',
      'cue_pair_similarity_max',
      'v2a_onset_alignment_tolerance_ms',
      'v2a_onset_alignment_rate_min',
      'v2a_onset_rise_db',
      'v2a_visual_event_confidence_min',
      'v2a_preview_sync_tolerance_ms',
      'v2a_output_duration_tolerance_ms',
      'speech_detection_rms_threshold_db',
      'speech_detection_min_duration_ms',
      'dialogue_tail_silence_floor_dbfs',
      'dialogue_tail_silence_min_ms',
      'dialogue_tail_silence_max_ms',
      'voice_conversion_length_tolerance_ms',
    ]);
  });

  it('is a closed list: an unknown name is not a threshold name', () => {
    expect(isQualityThresholdName('loop_seam_rms_difference_max')).toBe(true);
    expect(isQualityThresholdName('loop_seam_vibe_max')).toBe(false);
  });

  it('has an entry for every name, so a read is total', () => {
    for (const name of QUALITY_THRESHOLD_NAMES) {
      expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, name).name).toBe(name);
    }
    expect(listThresholds(INITIAL_QUALITY_THRESHOLD_SET)).toHaveLength(
      QUALITY_THRESHOLD_NAMES.length,
    );
  });
});

describe('per-threshold fields (Requirement 34.2)', () => {
  it('gives every threshold a name, a value, a unit and an adjustment range', () => {
    for (const entry of listThresholds(INITIAL_QUALITY_THRESHOLD_SET)) {
      expect(QUALITY_THRESHOLD_UNITS).toContain(entry.unit);
      expect(Number.isFinite(entry.value)).toBe(true);
      expect(entry.adjustableFrom).toBeLessThan(entry.adjustableTo);
      // The value in force must itself be adjustable, or the set would be unchangeable
      // in one direction from the moment it was created.
      expect(entry.value).toBeGreaterThanOrEqual(entry.adjustableFrom);
      expect(entry.value).toBeLessThanOrEqual(entry.adjustableTo);
    }
  });

  it('carries exactly one version identifier for the whole set', () => {
    expect(INITIAL_QUALITY_THRESHOLD_SET.version).toBe(INITIAL_QUALITY_THRESHOLD_SET_VERSION);
    // Not per threshold: a `QualityThreshold` has no version of its own.
    for (const entry of listThresholds(INITIAL_QUALITY_THRESHOLD_SET)) {
      expect(entry).not.toHaveProperty('version');
    }
  });
});

describe('initial values are Requirement 21 and 22 verbatim (Requirement 34.3)', () => {
  it('sets the four loop-seam thresholds to Requirement 21 values', () => {
    // 21.7 — 1.0 dB; 21.8 — 5%; 21.16 — -6 dB; 21.17 / design §5.3 — ±25 ms.
    expect(thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max')).toBe(1.0);
    expect(
      thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_sample_step_ratio_max'),
    ).toBe(0.05);
    expect(thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor')).toBe(-6.0);
    expect(
      thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'loop_bar_alignment_tolerance_ms'),
    ).toBe(25);
  });

  it('states each loop threshold in the unit its requirement uses', () => {
    expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max').unit).toBe(
      'db',
    );
    expect(
      threshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_sample_step_ratio_max').unit,
    ).toBe('amplitude_ratio');
    expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor').unit).toBe('db');
    expect(
      threshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_bar_alignment_tolerance_ms').unit,
    ).toBe('ms');
  });
});

describe('the speech projections (Requirements 25.19, 26.5, 26.25, 34.3, 34.6)', () => {
  it('reads Requirement 25.19\u2019s three numbers and the set version together', () => {
    expect(dialogueTailSilenceThresholds(INITIAL_QUALITY_THRESHOLD_SET)).toEqual({
      version: INITIAL_QUALITY_THRESHOLD_SET_VERSION,
      silenceFloorDbfs: -60.0,
      tailSilenceMinMs: 50,
      tailSilenceMaxMs: 200,
    });
  });

  it('reads Requirement 26.25\u2019s tolerance', () => {
    expect(voiceConversionThresholds(INITIAL_QUALITY_THRESHOLD_SET)).toEqual({
      version: INITIAL_QUALITY_THRESHOLD_SET_VERSION,
      lengthToleranceMs: 100,
    });
  });

  it('reuses Requirement 30.12\u2019s existing members for 26.5\u2019s speech regions', () => {
    // Not new members: the glossary defines 발화 구간 by Requirement 30's rule, so 26.5 and
    // 27.12 read the same two thresholds rather than introducing a second definition.
    expect(speechPresenceThresholds(INITIAL_QUALITY_THRESHOLD_SET)).toEqual({
      version: INITIAL_QUALITY_THRESHOLD_SET_VERSION,
      speechRmsThresholdDb: -45.0,
      speechMinDurationMs: 200,
    });
  });

  it('carries the new version after a change', () => {
    const change = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'voice_conversion_length_tolerance_ms',
      250,
    );
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(voiceConversionThresholds(change.set)).toEqual({
      version: INITIAL_QUALITY_THRESHOLD_SET_VERSION + 1,
      lengthToleranceMs: 250,
    });
  });
});

describe('the loop-seam projection (Requirements 21.6, 34.6)', () => {
  it('reads the four loop numbers and the set version together', () => {
    expect(loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET)).toEqual({
      version: INITIAL_QUALITY_THRESHOLD_SET_VERSION,
      seamRmsDifferenceMaxDb: 1.0,
      seamSampleStepRatioMax: 0.05,
      edgeEnergyFloorDb: -6.0,
      barAlignmentToleranceMs: 25,
    });
  });

  it('carries the new version after a change, so a verdict cannot cite a stale one', () => {
    const change = changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor', -9);
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(loopSeamThresholds(change.set)).toMatchObject({
      version: INITIAL_QUALITY_THRESHOLD_SET_VERSION + 1,
      edgeEnergyFloorDb: -9,
    });
  });
});

describe('changing a threshold (Requirements 34.4, 34.5, 34.10)', () => {
  it('bumps the single set version by exactly 1', () => {
    const change = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'loop_seam_rms_difference_max',
      2.0,
    );
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(change.set.version).toBe(INITIAL_QUALITY_THRESHOLD_SET.version + 1);
    expect(change.previousVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('reports both sides of the change, for the Audit_Log entry task 8.2 writes', () => {
    const change = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'loop_seam_rms_difference_max',
      2.0,
    );
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(change.previousValue).toBe(1.0);
    expect(change.nextValue).toBe(2.0);
    expect(change.name).toBe('loop_seam_rms_difference_max');
  });

  it('changes only the named threshold', () => {
    const change = changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor', -12);
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(thresholdValue(change.set, 'loop_edge_energy_floor')).toBe(-12);
    expect(thresholdValue(change.set, 'loop_seam_rms_difference_max')).toBe(1.0);
  });

  it('accepts both ends of the adjustment range', () => {
    const entry = threshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max');

    for (const value of [entry.adjustableFrom, entry.adjustableTo]) {
      expect(
        changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max', value).kind,
      ).toBe('applied');
    }
  });

  it('refuses a value outside the range and returns the range (Requirement 34.5)', () => {
    const entry = threshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max');
    const change = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'loop_seam_rms_difference_max',
      entry.adjustableTo + 1,
    );

    expect(change).toEqual({
      kind: 'rejected',
      name: 'loop_seam_rms_difference_max',
      requested: entry.adjustableTo + 1,
      adjustableFrom: entry.adjustableFrom,
      adjustableTo: entry.adjustableTo,
    });
  });

  it('refuses a non-finite value', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor', value).kind,
      ).toBe('rejected');
    }
  });

  it('keeps the existing value on a refusal (Requirement 34.5)', () => {
    changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max', 999);

    expect(
      thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'loop_seam_rms_difference_max'),
    ).toBe(1.0);
  });

  it('leaves the previous set untouched, so earlier assets keep their verdict (34.10)', () => {
    // The whole reason the set is a value object: an asset that recorded version 1 keeps
    // pointing at the values version 1 held, without anything having to copy them.
    const change = changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor', -15);
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor')).toBe(-6.0);
    expect(INITIAL_QUALITY_THRESHOLD_SET.version).toBe(INITIAL_QUALITY_THRESHOLD_SET_VERSION);
  });
});

describe('the read seam (Requirement 34.6; integration point for task 8.2)', () => {
  it('defaults to the initial values', () => {
    expect(fixedThresholdSource().current()).toBe(INITIAL_QUALITY_THRESHOLD_SET);
  });

  it('serves whichever set it was given, which is how task 8.2 publishes a change', () => {
    const change = changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'loop_edge_energy_floor', -8);
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    expect(fixedThresholdSource(change.set).current().version).toBe(2);
    expect(thresholdValue(fixedThresholdSource(change.set).current(), 'loop_edge_energy_floor'))
      .toBe(-8);
  });
});
