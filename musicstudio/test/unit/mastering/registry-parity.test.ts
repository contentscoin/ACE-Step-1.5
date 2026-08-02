import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DUCKING_ATTACK_DEFAULT_MS,
  DUCKING_ATTACK_MS,
  DUCKING_DEPTH_DB,
  DUCKING_DEPTH_DEFAULT_DB,
  DUCKING_RELEASE_DEFAULT_MS,
  DUCKING_RELEASE_MS,
  LOUDNESS_TARGET_DEFAULT_LUFS,
  LOUDNESS_TARGET_LUFS,
  LOUDNESS_TARGET_STEP_LUFS,
  MEASUREMENT_REPORT_STEP,
  OCTAVE_BAND_CENTRES_HZ,
  SPEECH_WINDOW_MS,
  SUGGESTION_FALLBACK_DEADLINE_MS,
  SUGGESTION_TIMEOUT_MS,
  TRUE_PEAK_CEILING_DBTP,
  TRUE_PEAK_OVERSAMPLING,
  TRUE_PEAK_TAKES_PRIORITY,
} from '../../../domain/mastering/bounds';
import { QUALITY_THRESHOLD_NAMES } from '../../../domain/quality/threshold-name';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  thresholdValue,
} from '../../../domain/quality/threshold-set';

/**
 * Parity guard between the TypeScript declarations of Requirement 30's numbers and
 * `dsp/src/musicstudio_dsp/mastering_registry.json`.
 *
 * **Validates: Requirements 30.5, 30.7, 30.9, 30.10, 30.12, 30.13, 30.14, 30.15, 30.16,
 * 30.20, 30.21, 30.22, 30.24, 34.3**
 *
 * Requirement 30's ranges have to be enforced twice — once in the product layer so a bad
 * request is refused *before* work is queued (which is what makes 30.26's synchronous
 * response possible), and once in the DSP worker so the queue is not a way around them.
 * Two enforcement points mean two chances to be wrong, and they are only "the same numbers"
 * for as long as something checks.
 *
 * This suite is that check, and it is the reason the Python side has no hand-written table:
 * `loudness.py` and `mastering.py` *load* the JSON, so the worker cannot drift by editing a
 * constant. What remains is drift between the TypeScript modules and the JSON, which is what
 * the assertions below cover — in **both directions**, because a one-way check would accept
 * a JSON file that had quietly grown an eleventh octave band or lost a threshold.
 *
 * This is the arrangement task 3.2 established in `test/unit/effects/registry-parity.test.ts`
 * and it is deliberately the same one, down to the "the numbers are the ones the clauses
 * quote" block at the end: parity alone would be satisfied by two files that agreed and were
 * both wrong.
 *
 * No Python process is started and no database is needed, so this runs in the fast loop.
 */

const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../dsp/src/musicstudio_dsp/mastering_registry.json', import.meta.url),
);

interface JsonRange {
  readonly min: number;
  readonly max: number;
}

interface JsonRegistry {
  readonly loudness_target_lufs: JsonRange;
  readonly loudness_target_step_lufs: number;
  readonly loudness_target_default_lufs: number;
  readonly true_peak_ceiling_dbtp: number;
  readonly true_peak_takes_priority: boolean;
  readonly true_peak_oversampling: number;
  readonly measurement_report_step: number;
  readonly ducking_depth_db: JsonRange;
  readonly ducking_depth_default_db: number;
  readonly ducking_attack_ms: JsonRange;
  readonly ducking_attack_default_ms: number;
  readonly ducking_release_ms: JsonRange;
  readonly ducking_release_default_ms: number;
  readonly speech_window_ms: number;
  readonly suggestion_timeout_ms: number;
  readonly suggestion_fallback_deadline_ms: number;
  readonly octave_band_centres_hz: readonly number[];
  readonly thresholds: Readonly<Record<string, number>>;
}

const shared = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as JsonRegistry;

/** The threshold members the worker is sent. Mirrored in the JSON's `thresholds` block. */
const MIRRORED_THRESHOLD_NAMES = [
  'speech_detection_rms_threshold_db',
  'speech_detection_min_duration_ms',
  'loudness_normalization_target_tolerance_lufs',
  'loudness_normalization_idempotence_gain_db',
  'dialogue_cleanup_non_speech_attenuation_min_db',
  'dialogue_cleanup_speech_loudness_tolerance_lufs',
  'dialogue_cleanup_length_tolerance_ms',
  'ducking_depth_accuracy_db',
  'ducking_non_speech_hold_db',
] as const;

describe('range parity (Requirements 30.5, 30.13, 30.14, 30.15)', () => {
  it('agrees on the loudness target range, step and default', () => {
    expect(shared.loudness_target_lufs).toEqual({
      min: LOUDNESS_TARGET_LUFS.min,
      max: LOUDNESS_TARGET_LUFS.max,
    });
    expect(shared.loudness_target_step_lufs).toBe(LOUDNESS_TARGET_STEP_LUFS);
    expect(shared.loudness_target_default_lufs).toBe(LOUDNESS_TARGET_DEFAULT_LUFS);
  });

  it('agrees on the ducking depth range and default', () => {
    expect(shared.ducking_depth_db).toEqual({
      min: DUCKING_DEPTH_DB.min,
      max: DUCKING_DEPTH_DB.max,
    });
    expect(shared.ducking_depth_default_db).toBe(DUCKING_DEPTH_DEFAULT_DB);
  });

  it('agrees on the attack range and default', () => {
    expect(shared.ducking_attack_ms).toEqual({
      min: DUCKING_ATTACK_MS.min,
      max: DUCKING_ATTACK_MS.max,
    });
    expect(shared.ducking_attack_default_ms).toBe(DUCKING_ATTACK_DEFAULT_MS);
  });

  it('agrees on the release range and default', () => {
    expect(shared.ducking_release_ms).toEqual({
      min: DUCKING_RELEASE_MS.min,
      max: DUCKING_RELEASE_MS.max,
    });
    expect(shared.ducking_release_default_ms).toBe(DUCKING_RELEASE_DEFAULT_MS);
  });
});

describe('output contract parity (Requirements 30.7, 30.24)', () => {
  it('agrees on the true-peak ceiling and that it takes priority', () => {
    // The precedence flag is mirrored as well as the number, so a worker that reached the
    // target by exceeding the ceiling could not claim the two sides disagreed about which
    // wins.
    expect(shared.true_peak_ceiling_dbtp).toBe(TRUE_PEAK_CEILING_DBTP);
    expect(shared.true_peak_takes_priority).toBe(TRUE_PEAK_TAKES_PRIORITY);
  });

  it('agrees on the oversampling factor', () => {
    // Requirement 30.24 says "4배 이상", so the two sides could legally differ — and must
    // not, because a side using 8 would report a higher peak for the same audio.
    expect(shared.true_peak_oversampling).toBe(TRUE_PEAK_OVERSAMPLING);
  });

  it('agrees on the reporting step', () => {
    expect(shared.measurement_report_step).toBe(MEASUREMENT_REPORT_STEP);
  });
});

describe('measurement parity (Requirements 30.12, 30.22)', () => {
  it('agrees on the speech analysis window', () => {
    expect(shared.speech_window_ms).toBe(SPEECH_WINDOW_MS);
  });

  it('declares the same ten octave band centres, in the same order', () => {
    // Order is part of the response contract: the caller pairs ten energies positionally,
    // so a reordered JSON would silently mislabel every band.
    expect(shared.octave_band_centres_hz).toEqual([...OCTAVE_BAND_CENTRES_HZ]);
  });

  it('has exactly ten bands on both sides', () => {
    expect(OCTAVE_BAND_CENTRES_HZ).toHaveLength(10);
    expect(shared.octave_band_centres_hz).toHaveLength(10);
  });
});

describe('suggestion service parity (Requirements 30.20, 30.21)', () => {
  it('agrees on the 120-second budget and the 5-second fallback deadline', () => {
    expect(shared.suggestion_timeout_ms).toBe(SUGGESTION_TIMEOUT_MS);
    expect(shared.suggestion_fallback_deadline_ms).toBe(SUGGESTION_FALLBACK_DEADLINE_MS);
  });
});

describe('threshold initial-value parity (Requirement 34.3)', () => {
  it('mirrors every threshold the worker is sent, and no others', () => {
    // Both directions. A JSON block that grew an entry would be a number the worker reads
    // and nothing in the product layer sets; one that lost an entry would leave the worker
    // with no default for a value the product layer may omit.
    expect(Object.keys(shared.thresholds).sort()).toEqual([...MIRRORED_THRESHOLD_NAMES].sort());
  });

  it('mirrors each one at the initial value the threshold set holds', () => {
    // The JSON carries *initial* values only; at runtime the current values travel with the
    // request, because Requirement 34.4 lets an operator change them between two runs.
    for (const name of MIRRORED_THRESHOLD_NAMES) {
      expect(shared.thresholds[name], name).toBe(
        thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, name),
      );
    }
  });

  it('mirrors only names that are actually threshold members', () => {
    for (const name of MIRRORED_THRESHOLD_NAMES) {
      expect(QUALITY_THRESHOLD_NAMES).toContain(name);
    }
  });
});

describe('the numbers are the ones Requirement 30 quotes', () => {
  /**
   * Spot-checks against the requirement text rather than against the other file.
   *
   * Parity alone would be satisfied by two files that agreed and were both wrong. These
   * assertions are the literal numbers from the clauses, so a transcription error is caught
   * even though both declarations contain it.
   */
  it('30.5 — the target range, step and default', () => {
    expect(LOUDNESS_TARGET_LUFS).toEqual({ min: -30.0, max: -6.0 });
    expect(LOUDNESS_TARGET_STEP_LUFS).toBe(0.1);
    expect(LOUDNESS_TARGET_DEFAULT_LUFS).toBe(-14.0);
  });

  it('30.7 — the true-peak ceiling', () => {
    expect(TRUE_PEAK_CEILING_DBTP).toBe(-1.0);
  });

  it('30.13, 30.14, 30.15 — the three ducking ranges and their defaults', () => {
    expect(DUCKING_DEPTH_DB).toEqual({ min: -24, max: -3 });
    expect(DUCKING_DEPTH_DEFAULT_DB).toBe(-12);
    expect(DUCKING_ATTACK_MS).toEqual({ min: 10, max: 500 });
    expect(DUCKING_ATTACK_DEFAULT_MS).toBe(50);
    expect(DUCKING_RELEASE_MS).toEqual({ min: 50, max: 2000 });
    expect(DUCKING_RELEASE_DEFAULT_MS).toBe(300);
  });

  it('30.12 — the 100 ms speech window', () => {
    expect(SPEECH_WINDOW_MS).toBe(100);
  });

  it('30.20, 30.21 — the two budgets', () => {
    expect(SUGGESTION_TIMEOUT_MS).toBe(120_000);
    expect(SUGGESTION_FALLBACK_DEADLINE_MS).toBe(5_000);
  });

  it('30.22 — the ten centre frequencies, verbatim and in order', () => {
    expect([...OCTAVE_BAND_CENTRES_HZ]).toEqual([
      31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
    ]);
  });

  it('30.24 — 4x oversampling, reported to 0.1', () => {
    expect(TRUE_PEAK_OVERSAMPLING).toBe(4);
    expect(MEASUREMENT_REPORT_STEP).toBe(0.1);
  });

  it('30.6, 30.8, 30.9, 30.10, 30.12, 30.16 — the seven threshold initial values', () => {
    const set = INITIAL_QUALITY_THRESHOLD_SET;
    expect(thresholdValue(set, 'loudness_normalization_target_tolerance_lufs')).toBe(0.5);
    expect(thresholdValue(set, 'loudness_normalization_idempotence_gain_db')).toBe(0.1);
    expect(thresholdValue(set, 'dialogue_cleanup_non_speech_attenuation_min_db')).toBe(10.0);
    expect(thresholdValue(set, 'dialogue_cleanup_speech_loudness_tolerance_lufs')).toBe(1.0);
    expect(thresholdValue(set, 'dialogue_cleanup_length_tolerance_ms')).toBe(10);
    expect(thresholdValue(set, 'ducking_depth_accuracy_db')).toBe(1.0);
    expect(thresholdValue(set, 'ducking_non_speech_hold_db')).toBe(0.5);
  });
});
