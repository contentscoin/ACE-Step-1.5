import { describe, expect, it } from 'vitest';

import {
  CRITERION_REQUIREMENT,
  LOOP_SEAM_CRITERIA,
  describeUnmetCriteria,
  evaluateLoopSeam,
  type ChannelLoopMeasurement,
  type LoopMeasurement,
} from '../../../domain/bgm/loop-seam';
import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';

/**
 * The four loop-seam criteria as pure predicates over a measurement.
 *
 * **Validates: Requirements 21.6, 21.7, 21.8, 21.16, 21.17, 21.18, 34.6**
 *
 * Measurements are stated by hand here rather than measured from audio. That is the
 * point of the split: these tests fix the *rules* — which numbers pass, which fail, and
 * what a failure is called — while `measurement.test.ts` fixes the *measuring* against
 * synthesised PCM. Combining the two would make it impossible to tell a wrong ceiling
 * from a wrongly computed RMS.
 */

const thresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);

/** A channel meeting every criterion: equal ends, tiny step, no edge dip. */
function compliantChannel(
  overrides: Partial<ChannelLoopMeasurement> = {},
): ChannelLoopMeasurement {
  return {
    headSeamRms: 0.5,
    tailSeamRms: 0.5,
    headEdgeRms: 0.5,
    tailEdgeRms: 0.5,
    overallRms: 0.5,
    firstSample: 0.1,
    lastSample: 0.1,
    peakAbs: 0.8,
    ...overrides,
  };
}

/** 4 bars at 120 BPM in 4/4 is 8000 ms exactly. */
function measurement(
  channels: readonly ChannelLoopMeasurement[],
  overrides: Partial<LoopMeasurement> = {},
): LoopMeasurement {
  return {
    sampleRate: 48_000,
    channels,
    durationMs: 8_000,
    bpm: 120,
    timeSignature: 4,
    integratedLoudnessLufs: -20,
    ...overrides,
  };
}

describe('a compliant loop (Requirement 21.6)', () => {
  it('satisfies all four criteria with no unmet names', () => {
    const verdict = evaluateLoopSeam(measurement([compliantChannel()]), thresholds);

    expect(verdict.satisfied).toBe(true);
    expect(verdict.unmet).toEqual([]);
  });

  it('reports the threshold set version it judged against (Requirement 34.6)', () => {
    const verdict = evaluateLoopSeam(measurement([compliantChannel()]), thresholds);

    expect(verdict.thresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('is unsatisfiable when there are no channels to have measured', () => {
    const verdict = evaluateLoopSeam(measurement([]), thresholds);

    expect(verdict.satisfied).toBe(false);
    expect([...verdict.unmet].sort()).toEqual([...LOOP_SEAM_CRITERIA].sort());
  });
});

describe('seam RMS continuity (Requirement 21.7)', () => {
  it('accepts a difference of exactly 1.0 dB', () => {
    // 1.0 dB is a factor of 10^(1/20); the ceiling is inclusive.
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ tailSeamRms: 0.5 * 10 ** (1 / 20) })]),
      thresholds,
    );

    expect(verdict.unmet).not.toContain('seam_rms_difference');
  });

  it('rejects a difference above 1.0 dB, in either direction', () => {
    for (const tailSeamRms of [0.5 * 10 ** (1.5 / 20), 0.5 / 10 ** (1.5 / 20)]) {
      const verdict = evaluateLoopSeam(
        measurement([compliantChannel({ tailSeamRms })]),
        thresholds,
      );

      expect(verdict.unmet).toContain('seam_rms_difference');
      expect(verdict.satisfied).toBe(false);
    }
  });

  it('treats two silent seam windows as no difference rather than as NaN', () => {
    // Both ends silent is a legitimate loop of a very quiet passage. A dB-domain
    // subtraction would yield NaN here and fail every comparison it touched.
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ headSeamRms: 0, tailSeamRms: 0 })]),
      thresholds,
    );

    expect(verdict.channels[0]?.seamRmsDifferenceDb).toBe(0);
    expect(verdict.unmet).not.toContain('seam_rms_difference');
  });

  it('rejects one silent end against a loud one', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ headSeamRms: 0 })]),
      thresholds,
    );

    expect(verdict.unmet).toContain('seam_rms_difference');
  });
});

describe('seam sample step (Requirement 21.8)', () => {
  it('accepts a step of exactly 5% of the channel peak', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ peakAbs: 0.8, firstSample: 0, lastSample: 0.04 })]),
      thresholds,
    );

    expect(verdict.channels[0]?.seamSampleStepRatio).toBeCloseTo(0.05, 12);
    expect(verdict.unmet).not.toContain('seam_sample_step');
  });

  it('rejects a step above 5% of the channel peak', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ peakAbs: 0.8, firstSample: 0, lastSample: 0.05 })]),
      thresholds,
    );

    expect(verdict.unmet).toContain('seam_sample_step');
  });

  it('measures the step against the channel peak, not against full scale', () => {
    // A quiet channel's 5% is 5% of *its* peak. The same absolute step that is fine in a
    // loud channel is a click in a quiet one, which is what the requirement says.
    const quiet = evaluateLoopSeam(
      measurement([compliantChannel({ peakAbs: 0.1, firstSample: 0, lastSample: 0.02 })]),
      thresholds,
    );
    const loud = evaluateLoopSeam(
      measurement([compliantChannel({ peakAbs: 1.0, firstSample: 0, lastSample: 0.02 })]),
      thresholds,
    );

    expect(quiet.unmet).toContain('seam_sample_step');
    expect(loud.unmet).not.toContain('seam_sample_step');
  });

  it('treats a wholly silent channel as having no discontinuity', () => {
    const verdict = evaluateLoopSeam(
      measurement([
        compliantChannel({ peakAbs: 0, firstSample: 0, lastSample: 0, headSeamRms: 0, tailSeamRms: 0 }),
      ]),
      thresholds,
    );

    expect(verdict.channels[0]?.seamSampleStepRatio).toBe(0);
    expect(verdict.unmet).not.toContain('seam_sample_step');
  });
});

describe('edge energy (Requirement 21.16)', () => {
  it('accepts an edge exactly 6 dB below the overall RMS', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ overallRms: 0.5, headEdgeRms: 0.5 / 10 ** (6 / 20) })]),
      thresholds,
    );

    expect(verdict.channels[0]?.headEdgeRelativeDb).toBeCloseTo(-6, 10);
    expect(verdict.unmet).not.toContain('edge_energy');
  });

  it('rejects a head edge more than 6 dB below the overall RMS', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ overallRms: 0.5, headEdgeRms: 0.5 / 10 ** (7 / 20) })]),
      thresholds,
    );

    expect(verdict.unmet).toContain('edge_energy');
  });

  it('rejects a quiet tail edge as well as a quiet head edge', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ overallRms: 0.5, tailEdgeRms: 0.01 })]),
      thresholds,
    );

    expect(verdict.unmet).toContain('edge_energy');
  });

  it('accepts an edge louder than the overall RMS', () => {
    // The rule is a floor, not a window: a loop that starts on its loudest bar is fine.
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel({ overallRms: 0.3, headEdgeRms: 0.6, tailEdgeRms: 0.6 })]),
      thresholds,
    );

    expect(verdict.unmet).not.toContain('edge_energy');
  });
});

describe('bar alignment (Requirement 21.17)', () => {
  it('accepts a duration that is a whole number of bars', () => {
    const verdict = evaluateLoopSeam(measurement([compliantChannel()]), thresholds);

    expect(verdict.barAlignment.barCount).toBe(4);
    expect(verdict.barAlignment.errorMs).toBeCloseTo(0, 10);
    expect(verdict.unmet).not.toContain('bar_alignment');
  });

  it('accepts an error of exactly 25 ms and rejects 26 ms', () => {
    const within = evaluateLoopSeam(
      measurement([compliantChannel()], { durationMs: 8_025 }),
      thresholds,
    );
    const beyond = evaluateLoopSeam(
      measurement([compliantChannel()], { durationMs: 8_026 }),
      thresholds,
    );

    expect(within.unmet).not.toContain('bar_alignment');
    expect(beyond.unmet).toContain('bar_alignment');
  });

  it('rejects a loop longer than 64 bars', () => {
    // 65 bars at 120 BPM 4/4 is 130 000 ms — an exact multiple, and still refused.
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel()], { durationMs: 130_000 }),
      thresholds,
    );

    expect(verdict.barAlignment.barCount).toBe(65);
    expect(verdict.barAlignment.errorMs).toBeCloseTo(0, 10);
    expect(verdict.unmet).toContain('bar_alignment');
  });

  it('uses the recorded time signature, so 3/4 and 4/4 disagree about the same length', () => {
    const inFour = evaluateLoopSeam(measurement([compliantChannel()]), thresholds);
    const inThree = evaluateLoopSeam(
      measurement([compliantChannel()], { timeSignature: 3 }),
      thresholds,
    );

    expect(inFour.unmet).not.toContain('bar_alignment');
    // A bar of 3/4 at 120 BPM is 1500 ms; 8000 ms is 5.33 bars.
    expect(inThree.unmet).toContain('bar_alignment');
  });

  it('rejects a loop shorter than half a bar rather than rounding it up to one', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel()], { durationMs: 400 }),
      thresholds,
    );

    expect(verdict.barAlignment.barCount).toBe(0);
    expect(verdict.unmet).toContain('bar_alignment');
  });
});

describe('every channel must comply (Requirements 21.7, 21.8, 21.16)', () => {
  it('fails a stereo loop whose left channel clicks and whose right is clean', () => {
    const verdict = evaluateLoopSeam(
      measurement([
        compliantChannel({ firstSample: 0, lastSample: 0.6, peakAbs: 0.8 }),
        compliantChannel(),
      ]),
      thresholds,
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.unmet).toEqual(['seam_sample_step']);
    expect(verdict.channels).toHaveLength(2);
    expect(verdict.channels[1]?.seamSampleStepRatio).toBe(0);
  });

  it('reports per-channel evidence indexed by channel', () => {
    const verdict = evaluateLoopSeam(
      measurement([compliantChannel(), compliantChannel()]),
      thresholds,
    );

    expect(verdict.channels.map((evidence) => evidence.channel)).toEqual([0, 1]);
  });
});

describe('unmet criterion names (Requirement 21.18)', () => {
  it('names all four criteria when all four fail', () => {
    const verdict = evaluateLoopSeam(
      measurement(
        [
          compliantChannel({
            tailSeamRms: 0.01,
            firstSample: 0,
            lastSample: 0.7,
            headEdgeRms: 0.001,
          }),
        ],
        { durationMs: 7_000 },
      ),
      thresholds,
    );

    expect([...verdict.unmet].sort()).toEqual([...LOOP_SEAM_CRITERIA].sort());
  });

  it('maps each criterion name to the requirement it enforces', () => {
    expect(CRITERION_REQUIREMENT).toEqual({
      seam_rms_difference: '21.7',
      seam_sample_step: '21.8',
      edge_energy: '21.16',
      bar_alignment: '21.17',
    });
  });

  it('describes an unmet list as name-and-requirement pairs', () => {
    expect(describeUnmetCriteria(['edge_energy', 'bar_alignment'])).toEqual([
      { criterion: 'edge_energy', requirement: '21.16' },
      { criterion: 'bar_alignment', requirement: '21.17' },
    ]);
  });
});

describe('thresholds come from the set, not from literals (Requirement 34)', () => {
  it('admits a seam a looser set permits and the initial set refuses', () => {
    const loose = { ...thresholds, seamRmsDifferenceMaxDb: 3.0, version: 7 };
    const borderline = measurement([compliantChannel({ tailSeamRms: 0.5 * 10 ** (2 / 20) })]);

    expect(evaluateLoopSeam(borderline, thresholds).unmet).toContain('seam_rms_difference');
    expect(evaluateLoopSeam(borderline, loose).satisfied).toBe(true);
    expect(evaluateLoopSeam(borderline, loose).thresholdSetVersion).toBe(7);
  });
});
