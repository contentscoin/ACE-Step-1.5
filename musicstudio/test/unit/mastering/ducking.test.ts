import { describe, expect, it } from 'vitest';

import {
  automationStructureDefects,
  duckingDefects,
  gainAtMs,
  isValidDuckingAutomation,
  speechDurationMs,
  type TrackVolumeAutomation,
} from '../../../domain/mastering/ducking';
import { duckingThresholds } from '../../../domain/quality/mastering-thresholds';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { compliantCurve } from '../../support/mastering-harness';

/**
 * The track volume automation curve, and the two clauses it is verified against.
 *
 * **Validates: Requirements 30.12, 30.13, 30.16, 30.17**
 *
 * This module *verifies* curves rather than generating them — the worker generates, for the
 * reason `domain/mastering/ducking.ts` states — so the tests are about what it accepts and
 * what it rejects. The rejections are the point: a verifier that accepted everything would
 * make Requirements 30.12 and 30.16 unenforceable, and the worker is where they could
 * plausibly go wrong.
 */

const THRESHOLDS = duckingThresholds(INITIAL_QUALITY_THRESHOLD_SET);

function automation(overrides: Partial<TrackVolumeAutomation> = {}): TrackVolumeAutomation {
  const speechRegions = overrides.speechRegions ?? [{ startMs: 1_000, endMs: 1_500 }];
  const depthDb = overrides.depthDb ?? -12;
  const attackMs = overrides.attackMs ?? 50;
  const releaseMs = overrides.releaseMs ?? 300;
  const durationMs = overrides.durationMs ?? 3_000;
  return {
    speechRegions,
    depthDb,
    attackMs,
    releaseMs,
    durationMs,
    points:
      overrides.points ??
      compliantCurve(speechRegions, durationMs, depthDb, attackMs, releaseMs),
  };
}

describe('reading the curve (Requirement 30.17)', () => {
  it('interpolates linearly in dB between breakpoints', () => {
    const curve = automation({
      points: [
        { timeMs: 0, gainDb: 0 },
        { timeMs: 100, gainDb: -12 },
      ],
    });

    expect(gainAtMs(curve, 0)).toBe(0);
    expect(gainAtMs(curve, 50)).toBeCloseTo(-6, 9);
    expect(gainAtMs(curve, 100)).toBe(-12);
  });

  it('holds the end values flat outside the breakpoints', () => {
    const curve = automation({
      points: [
        { timeMs: 100, gainDb: -3 },
        { timeMs: 200, gainDb: -9 },
      ],
    });

    expect(gainAtMs(curve, 0)).toBe(-3);
    expect(gainAtMs(curve, 9_999)).toBe(-9);
  });

  it('reads 0 dB from an empty curve rather than throwing', () => {
    expect(gainAtMs(automation({ points: [] }), 500)).toBe(0);
  });
});

describe('structural validity (Requirement 30.17)', () => {
  it('accepts the curve the worker produces', () => {
    expect(automationStructureDefects(automation())).toEqual([]);
    expect(isValidDuckingAutomation(automation(), THRESHOLDS)).toBe(true);
  });

  it('refuses a curve with no points', () => {
    expect(automationStructureDefects(automation({ points: [] }))).toEqual([
      { kind: 'no_points' },
    ]);
  });

  it('refuses two points at the same instant', () => {
    // A user edit could produce this (Requirement 30.17 lets them edit), and it makes the
    // curve ambiguous at that instant.
    const defects = automationStructureDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 500, gainDb: -6 },
          { timeMs: 500, gainDb: -12 },
        ],
      }),
    );

    expect(defects).toContainEqual({ kind: 'time_not_ascending', index: 2 });
  });

  it('refuses a gain above 0 dB, which is a boost rather than a duck', () => {
    const defects = automationStructureDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 500, gainDb: 3 },
        ],
      }),
    );

    expect(defects).toContainEqual({ kind: 'gain_out_of_range', index: 1 });
  });

  it('refuses a gain deeper than the requested depth', () => {
    const defects = automationStructureDefects(
      automation({
        depthDb: -12,
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 500, gainDb: -18 },
        ],
      }),
    );

    expect(defects).toContainEqual({ kind: 'gain_out_of_range', index: 1 });
  });

  it('refuses a depth outside Requirement 30.13\u2019s range', () => {
    expect(automationStructureDefects(automation({ depthDb: -40 }))).toContainEqual({
      kind: 'depth_out_of_range',
    });
  });

  it('refuses a point outside the track', () => {
    const defects = automationStructureDefects(
      automation({
        durationMs: 1_000,
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 5_000, gainDb: 0 },
        ],
      }),
    );

    expect(defects).toContainEqual({ kind: 'time_out_of_bounds', index: 1 });
  });

  it('refuses a non-finite value', () => {
    const defects = automationStructureDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: Number.NaN, gainDb: -6 },
        ],
      }),
    );

    expect(defects).toContainEqual({ kind: 'non_finite', index: 1 });
  });

  it('refuses a malformed or overlapping speech region', () => {
    expect(
      automationStructureDefects(
        automation({ speechRegions: [{ startMs: 900, endMs: 900 }], points: [{ timeMs: 0, gainDb: 0 }] }),
      ),
    ).toContainEqual({ kind: 'speech_region_malformed', regionIndex: 0 });

    expect(
      automationStructureDefects(
        automation({
          speechRegions: [
            { startMs: 500, endMs: 1_500 },
            { startMs: 1_200, endMs: 2_000 },
          ],
          points: [{ timeMs: 0, gainDb: 0 }],
        }),
      ),
    ).toContainEqual({ kind: 'speech_region_malformed', regionIndex: 1 });
  });
});

describe('Requirement 30.12 — every speech region reaches the requested depth', () => {
  it('accepts a curve that holds the depth across the whole region', () => {
    expect(duckingDefects(automation(), THRESHOLDS)).toEqual([]);
  });

  it('refuses a curve whose attack starts at the region rather than ending there', () => {
    // The look-ahead. Without it the first `attackMs` of every line is under-ducked, which
    // is precisely what 30.12's ±1.0 dB forbids.
    const defects = duckingDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 1_000, gainDb: 0 },
          { timeMs: 1_050, gainDb: -12 },
          { timeMs: 1_500, gainDb: -12 },
          { timeMs: 1_800, gainDb: 0 },
          { timeMs: 3_000, gainDb: 0 },
        ],
      }),
      THRESHOLDS,
    );

    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ kind: 'speech_region_under_ducked', regionIndex: 0 });
  });

  it('accepts a duck within the accuracy tolerance of the depth', () => {
    // ±1.0 dB: a curve holding -11.5 dB for a -12 dB request is compliant.
    const defects = duckingDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 950, gainDb: 0 },
          { timeMs: 1_000, gainDb: -11.5 },
          { timeMs: 1_500, gainDb: -11.5 },
          { timeMs: 1_800, gainDb: 0 },
          { timeMs: 3_000, gainDb: 0 },
        ],
      }),
      THRESHOLDS,
    );

    expect(defects).toEqual([]);
  });

  it('refuses a duck just outside the accuracy tolerance', () => {
    const defects = duckingDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 950, gainDb: 0 },
          { timeMs: 1_000, gainDb: -10.5 },
          { timeMs: 1_500, gainDb: -10.5 },
          { timeMs: 1_800, gainDb: 0 },
          { timeMs: 3_000, gainDb: 0 },
        ],
      }),
      THRESHOLDS,
    );

    expect(defects[0]).toMatchObject({ kind: 'speech_region_under_ducked' });
  });

  it('reports the worst gain it found, so a defect is diagnosable', () => {
    const defects = duckingDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 1_000, gainDb: 0 },
          { timeMs: 1_500, gainDb: -12 },
          { timeMs: 1_800, gainDb: 0 },
          { timeMs: 3_000, gainDb: 0 },
        ],
      }),
      THRESHOLDS,
    );

    const defect = defects[0];
    if (defect?.kind !== 'speech_region_under_ducked') throw new Error('expected under-ducked');
    expect(defect.worstGainDb).toBeCloseTo(0, 6);
  });
});

describe('Requirement 30.16 — the bed holds still outside the ramps', () => {
  it('accepts the worker\u2019s curve, whose ramps are the only excursions', () => {
    expect(duckingDefects(automation(), THRESHOLDS)).toEqual([]);
  });

  it('refuses a curve that never returns to unity after the release', () => {
    const defects = duckingDefects(
      automation({
        points: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 950, gainDb: 0 },
          { timeMs: 1_000, gainDb: -12 },
          { timeMs: 1_500, gainDb: -12 },
          { timeMs: 1_800, gainDb: -3 },
          { timeMs: 3_000, gainDb: -3 },
        ],
      }),
      THRESHOLDS,
    );

    expect(defects[0]).toMatchObject({ kind: 'non_speech_level_moved' });
  });

  it('exempts the attack look-ahead and the release tail, as the spec conflict requires', () => {
    // Requirement 30.16 read literally contradicts 30.14/30.15, since a ramp is attenuated
    // and outside the region by construction. `domain/mastering/ducking.ts` documents the
    // steady-state reading; this pins it so the choice cannot be reverted silently.
    const curve = automation({ attackMs: 500, releaseMs: 2_000 });

    expect(gainAtMs(curve, 1_400)).toBeLessThan(-1);
    expect(duckingDefects(curve, THRESHOLDS)).toEqual([]);
  });

  it('reports only once even though a drift spans an interval', () => {
    const defects = duckingDefects(
      automation({
        speechRegions: [],
        points: [
          { timeMs: 0, gainDb: -6 },
          { timeMs: 3_000, gainDb: -6 },
        ],
      }),
      THRESHOLDS,
    );

    expect(defects).toHaveLength(1);
  });

  it('accepts a drift inside the hold tolerance', () => {
    // ±0.5 dB.
    expect(
      duckingDefects(
        automation({
          speechRegions: [],
          points: [
            { timeMs: 0, gainDb: -0.4 },
            { timeMs: 3_000, gainDb: -0.4 },
          ],
        }),
        THRESHOLDS,
      ),
    ).toEqual([]);
  });
});

describe('speechDurationMs', () => {
  it('sums the regions', () => {
    expect(
      speechDurationMs([
        { startMs: 500, endMs: 1_500 },
        { startMs: 2_000, endMs: 2_800 },
      ]),
    ).toBe(1_800);
  });

  it('is zero for no speech', () => {
    expect(speechDurationMs([])).toBe(0);
  });
});
