import { describe, expect, it } from 'vitest';

import {
  cueSimilarityThresholds,
  packExportThresholds,
  packLoudnessThresholds,
  soundPackThresholds,
} from '../../../domain/quality/sound-pack-thresholds';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  changeThreshold,
  threshold,
  type QualityThresholdSet,
} from '../../../domain/quality/threshold-set';
import type { QualityThresholdName } from '../../../domain/quality/threshold-name';

/** `changeThreshold` for a value known to be inside its adjustment range. */
function applied(
  set: QualityThresholdSet,
  name: QualityThresholdName,
  value: number,
): QualityThresholdSet {
  const change = changeThreshold(set, name, value);
  if (change.kind !== 'applied') throw new Error(`${name} rejected ${String(value)}`);
  return change.set;
}

/**
 * Requirement 24's adjustable numbers, as projections of the Quality_Threshold_Set.
 *
 * Requirement 34.3 makes the values Requirement 24 quotes the set's *initial* values, so these
 * tests do two things: pin those initial values against the clauses, and check that a projection
 * follows the set rather than a literal — which is what Requirement 34.4 needs and what a
 * hard-coded 0.95 somewhere under `domain/sound-pack/` would break.
 */

describe('the initial values are Requirement 24\'s numbers (34.3)', () => {
  it('states 24.7\'s band, 24.9\'s ceiling and 24.10\'s budget', () => {
    const thresholds = soundPackThresholds(INITIAL_QUALITY_THRESHOLD_SET);

    expect(thresholds.loudnessMinLufs).toBe(-25);
    expect(thresholds.loudnessMaxLufs).toBe(-21);
    expect(thresholds.cuePairSimilarityMax).toBe(0.95);
    expect(thresholds.exportBudgetMs).toBe(60_000);
    expect(thresholds.version).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('records each with the unit it is measured in (34.2)', () => {
    expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_loudness_min').unit).toBe('lufs');
    expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_loudness_max').unit).toBe('lufs');
    expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, 'cue_pair_similarity_max').unit).toBe(
      'cosine_similarity',
    );
    expect(threshold(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_export_budget_ms').unit).toBe('ms');
  });

  it('bounds the export budget\'s adjustment range on both sides (34.2)', () => {
    const entry = threshold(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_export_budget_ms');

    // A floor of five seconds, because 156 in-process encodes measure well under one second and a
    // lower budget would fail on a loaded runner rather than on a regression; a ceiling of ten
    // minutes, past which "returns the archive" stops describing a synchronous download.
    expect(entry.adjustableFrom).toBe(5_000);
    expect(entry.adjustableTo).toBe(600_000);
    expect(entry.value).toBeGreaterThanOrEqual(entry.adjustableFrom);
    expect(entry.value).toBeLessThanOrEqual(entry.adjustableTo);
  });
});

describe('the projections follow the set (Requirement 34.4)', () => {
  it('rejects a budget outside its adjustment range, keeping the set (34.5)', () => {
    expect(
      changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_export_budget_ms', 1_000).kind,
    ).toBe('rejected');
    expect(
      changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_export_budget_ms', 700_000).kind,
    ).toBe('rejected');
  });

  it('reports an adjusted ceiling and the version it came from', () => {
    const adjusted = applied(INITIAL_QUALITY_THRESHOLD_SET, 'cue_pair_similarity_max', 0.8);

    expect(cueSimilarityThresholds(adjusted).cuePairSimilarityMax).toBe(0.8);
    expect(cueSimilarityThresholds(adjusted).version).toBe(
      INITIAL_QUALITY_THRESHOLD_SET.version + 1,
    );
  });

  it('carries an adjusted loudness band and export budget through', () => {
    const adjusted = applied(
      applied(INITIAL_QUALITY_THRESHOLD_SET, 'sound_pack_loudness_max', -19),
      'sound_pack_export_budget_ms',
      90_000,
    );

    expect(packLoudnessThresholds(adjusted).loudnessMaxLufs).toBe(-19);
    expect(packExportThresholds(adjusted).exportBudgetMs).toBe(90_000);
    // One read yields the values *and* the version, so a verdict and the version recorded beside
    // it (Requirement 34.6) cannot come from two different sets.
    expect(packExportThresholds(adjusted).version).toBe(
      packLoudnessThresholds(adjusted).version,
    );
  });

  it('narrows to just the numbers a caller needs, so the wrong one cannot be compared', () => {
    // `packLoudnessThresholds` has no similarity ceiling on it at all, which is the point: a
    // future edit cannot compare a loudness against 0.95 without the type system objecting.
    expect(Object.keys(packLoudnessThresholds(INITIAL_QUALITY_THRESHOLD_SET))).toEqual([
      'version',
      'loudnessMinLufs',
      'loudnessMaxLufs',
    ]);
    expect(Object.keys(cueSimilarityThresholds(INITIAL_QUALITY_THRESHOLD_SET))).toEqual([
      'version',
      'cuePairSimilarityMax',
    ]);
    expect(Object.keys(packExportThresholds(INITIAL_QUALITY_THRESHOLD_SET))).toEqual([
      'version',
      'exportBudgetMs',
    ]);
  });
});
