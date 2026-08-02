import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { integratedLoudnessLufs } from '../../domain/audio/loudness';
import { amplitudeDifferenceDb } from '../../domain/audio/level';
import { durationMs, type PcmAudio } from '../../domain/audio/pcm';
import { barDurationMs, evaluateBarAlignment } from '../../domain/bgm/bar-alignment';
import {
  BGM_LOOP_BAR_MULTIPLE_MAX,
  BGM_LOOP_BAR_MULTIPLE_MIN,
} from '../../domain/bgm/bounds';
import {
  LOOP_SEAM_CRITERIA,
  evaluateLoopSeam,
  type LoopMeasurement,
} from '../../domain/bgm/loop-seam';
import { planIntensityLadder, verifyIntensityLadder } from '../../domain/bgm/intensity-ladder';
import { loopSeamThresholds } from '../../domain/quality/loop-seam-thresholds';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../domain/quality/threshold-set';
import { measureLoopSync } from '../../services/sound/in-process-measurement';
import {
  TEST_SAMPLE_RATE,
  compliantLoop,
  monoAudio,
  scaled,
  sine,
  stereoAudio,
  withClickAt,
  withFadeIn,
  withFadeOut,
} from '../support/pcm-synthesis';

/**
 * Loop seam verification, as invariants over generated inputs.
 *
 * **Validates: Requirements 21.7, 21.8, 21.10, 21.11, 21.16, 21.17, 21.18**
 *
 * **Scope note — these are not any of design §10's 24 numbered Correctness Properties.**
 * §10's "PBT 적용 영역" list names 루프 이음 검증 as an area for property testing, but the
 * numbered Property list contains no entry for it and task 9.2's ownership table assigns
 * none to task 2.4. So this file deliberately does not claim a Property number, and task
 * 9.2's coverage audit must not count it as one of the 24. Adding a numbered property for
 * the loop seam would be a change to design §10, which is not this task's to make.
 *
 * What is asserted here that the example-based tests cannot: that the verdict is a
 * *conjunction over channels and criteria* for every input, that the measurement never
 * produces `NaN`, and that bar alignment agrees with its own arithmetic at every tempo in
 * Requirement 4.3's range rather than at the four tempi a test would otherwise pick.
 *
 * Every buffer is synthesised in TypeScript, so no audio infrastructure is needed and
 * every run is deterministic given its seed.
 */

const thresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const RUNS = { numRuns: 100 };

/** Requirement 4.3's tempo range, which Requirement 21 inherits. */
const arbBpm = fc.integer({ min: 30, max: 300 });
/** Requirement 4.4's time signatures. */
const arbTimeSignature = fc.constantFrom(2, 3, 4, 6);
const arbBarCount = fc.integer({ min: BGM_LOOP_BAR_MULTIPLE_MIN, max: 16 });
const arbAmplitude = fc.double({ min: 0.05, max: 1.0, noNaN: true });

/** A finite, in-range amplitude for a hand-built measurement. */
const arbLevel = fc.double({ min: 0, max: 1, noNaN: true });

const arbChannelMeasurement = fc.record({
  headSeamRms: arbLevel,
  tailSeamRms: arbLevel,
  headEdgeRms: arbLevel,
  tailEdgeRms: arbLevel,
  overallRms: arbLevel,
  firstSample: fc.double({ min: -1, max: 1, noNaN: true }),
  lastSample: fc.double({ min: -1, max: 1, noNaN: true }),
  peakAbs: arbLevel,
});

const arbMeasurement: fc.Arbitrary<LoopMeasurement> = fc.record({
  sampleRate: fc.constantFrom(44_100, 48_000, 96_000),
  channels: fc.array(arbChannelMeasurement, { minLength: 1, maxLength: 2 }),
  durationMs: fc.double({ min: 5_000, max: 600_000, noNaN: true }),
  bpm: arbBpm,
  timeSignature: arbTimeSignature,
  integratedLoudnessLufs: fc.double({ min: -70, max: 0, noNaN: true }),
});

describe('the loop verdict is total and well-formed', () => {
  it('never reports an unmet name outside the four criteria', () => {
    fc.assert(
      fc.property(arbMeasurement, (measurement) => {
        const verdict = evaluateLoopSeam(measurement, thresholds);

        for (const criterion of verdict.unmet) {
          expect(LOOP_SEAM_CRITERIA).toContain(criterion);
        }
        // Requirement 21.18 returns the *list* of unmet names, so duplicates would make
        // the payload ambiguous.
        expect(new Set(verdict.unmet).size).toBe(verdict.unmet.length);
      }),
      RUNS,
    );
  });

  it('is satisfied exactly when nothing is unmet', () => {
    fc.assert(
      fc.property(arbMeasurement, (measurement) => {
        const verdict = evaluateLoopSeam(measurement, thresholds);

        expect(verdict.satisfied).toBe(verdict.unmet.length === 0);
      }),
      RUNS,
    );
  });

  it('never produces NaN evidence, whatever the measurement', () => {
    // Silence, zero peaks and equal levels are all legitimate, and each is a place a
    // dB-domain subtraction would produce NaN and silently fail every comparison.
    fc.assert(
      fc.property(arbMeasurement, (measurement) => {
        for (const evidence of evaluateLoopSeam(measurement, thresholds).channels) {
          expect(Number.isNaN(evidence.seamRmsDifferenceDb)).toBe(false);
          expect(Number.isNaN(evidence.seamSampleStepRatio)).toBe(false);
          expect(Number.isNaN(evidence.headEdgeRelativeDb)).toBe(false);
          expect(Number.isNaN(evidence.tailEdgeRelativeDb)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it('reports the version of whatever threshold set it was given', () => {
    // Requirement 34.6: the version travels with the verdict so the asset can record it.
    fc.assert(
      fc.property(arbMeasurement, fc.integer({ min: 1, max: 10_000 }), (measurement, version) => {
        expect(evaluateLoopSeam(measurement, { ...thresholds, version }).thresholdSetVersion)
          .toBe(version);
      }),
      RUNS,
    );
  });

  it('is a conjunction over channels: adding a failing channel cannot make it pass', () => {
    // Requirements 21.7, 21.8 and 21.16 say "모든 채널에서" / "각 채널에서". A stereo loop
    // whose left channel clicks is a clicking loop, however clean the right one is.
    fc.assert(
      fc.property(arbChannelMeasurement, arbChannelMeasurement, (first, second) => {
        const left = evaluateLoopSeam({ ...base(), channels: [first] }, thresholds);
        const right = evaluateLoopSeam({ ...base(), channels: [second] }, thresholds);
        const both = evaluateLoopSeam({ ...base(), channels: [first, second] }, thresholds);

        expect(both.satisfied).toBe(left.satisfied && right.satisfied);
        for (const criterion of [...left.unmet, ...right.unmet]) {
          expect(both.unmet).toContain(criterion);
        }
      }),
      RUNS,
    );
  });

  /** A bar-aligned frame for the channel-conjunction property to vary channels within. */
  function base(): LoopMeasurement {
    return {
      sampleRate: 48_000,
      channels: [],
      durationMs: 8_000,
      bpm: 120,
      timeSignature: 4,
      integratedLoudnessLufs: -20,
    };
  }
});

describe('bar alignment agrees with its own arithmetic (Requirement 21.17)', () => {
  it('accepts an exact whole number of bars at any tempo and time signature', () => {
    fc.assert(
      fc.property(arbBpm, arbTimeSignature, arbBarCount, (bpm, timeSignature, barCount) => {
        const alignment = evaluateBarAlignment({
          durationMs: barCount * barDurationMs(bpm, timeSignature),
          bpm,
          timeSignature,
          toleranceMs: thresholds.barAlignmentToleranceMs,
        });

        expect(alignment.barCount).toBe(barCount);
        expect(alignment.errorMs).toBeLessThan(1e-6);
        expect(alignment.aligned).toBe(true);
      }),
      RUNS,
    );
  });

  it('rejects a duration half a bar away from any multiple', () => {
    // Exactly between two multiples is the worst case, and it must fail for every tempo
    // whose half-bar exceeds the 25 ms tolerance — which is every tempo in the range,
    // since the shortest bar here is 2 beats at 300 BPM, i.e. 400 ms.
    fc.assert(
      fc.property(arbBpm, arbTimeSignature, arbBarCount, (bpm, timeSignature, barCount) => {
        const bar = barDurationMs(bpm, timeSignature);
        const alignment = evaluateBarAlignment({
          durationMs: (barCount + 0.5) * bar,
          bpm,
          timeSignature,
          toleranceMs: thresholds.barAlignmentToleranceMs,
        });

        expect(alignment.aligned).toBe(false);
      }),
      RUNS,
    );
  });

  it('refuses any multiple outside 1–64, however exact', () => {
    fc.assert(
      fc.property(
        arbBpm,
        arbTimeSignature,
        fc.integer({ min: BGM_LOOP_BAR_MULTIPLE_MAX + 1, max: 200 }),
        (bpm, timeSignature, barCount) => {
          const alignment = evaluateBarAlignment({
            durationMs: barCount * barDurationMs(bpm, timeSignature),
            bpm,
            timeSignature,
            toleranceMs: thresholds.barAlignmentToleranceMs,
          });

          expect(alignment.errorMs).toBeLessThan(1e-6);
          expect(alignment.aligned).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('is monotone in the tolerance: a wider budget never rejects what a narrower accepted', () => {
    fc.assert(
      fc.property(
        arbBpm,
        arbTimeSignature,
        fc.double({ min: 5_000, max: 120_000, noNaN: true }),
        fc.double({ min: 1, max: 100, noNaN: true }),
        fc.double({ min: 1, max: 100, noNaN: true }),
        (bpm, timeSignature, length, first, second) => {
          const narrow = Math.min(first, second);
          const wide = Math.max(first, second);
          const at = (toleranceMs: number): boolean =>
            evaluateBarAlignment({ durationMs: length, bpm, timeSignature, toleranceMs }).aligned;

          if (at(narrow)) expect(at(wide)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe('measurement over synthesised PCM (Requirements 21.7, 21.8, 21.16)', () => {
  it('admits a bar-aligned whole-cycle loop at any tempo, signature and level', () => {
    // The constructive direction: a loop built to satisfy all four criteria must be judged
    // to satisfy them, for every tempo and amplitude — not just the one a fixture picked.
    fc.assert(
      fc.property(
        arbBpm,
        arbTimeSignature,
        fc.integer({ min: 1, max: 8 }),
        arbAmplitude,
        (bpm, timeSignature, barCount, amplitude) => {
          const loop = compliantLoop({ bpm, timeSignature, barCount, amplitude });
          const verdict = evaluateLoopSeam(
            measureLoopSync({
              subject: { kind: 'pcm', audio: loop.audio },
              bpm,
              timeSignature,
            }),
            thresholds,
          );

          expect(verdict.unmet).toEqual([]);
        },
      ),
      RUNS,
    );
  });

  it('measures every channel without NaN, for any synthesised buffer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4_000 }),
        arbAmplitude,
        fc.constantFrom(44_100, 48_000),
        (frameCount, amplitude, sampleRate) => {
          const channel = sine(220, frameCount, amplitude, sampleRate);
          const measurement = measureLoopSync({
            subject: { kind: 'pcm', audio: stereoAudio(channel, scaled(channel, 0.5), sampleRate) },
            bpm: 120,
            timeSignature: 4,
          });

          for (const measured of measurement.channels) {
            for (const value of Object.values(measured)) {
              expect(Number.isNaN(value)).toBe(false);
            }
            // RMS never exceeds the peak, for any window of any signal.
            expect(measured.overallRms).toBeLessThanOrEqual(measured.peakAbs + 1e-6);
            expect(measured.headSeamRms).toBeLessThanOrEqual(measured.peakAbs + 1e-6);
          }
          expect(measurement.durationMs).toBeCloseTo((frameCount * 1000) / sampleRate, 6);
        },
      ),
      RUNS,
    );
  });

  it('detects a seam click of any audible size (Requirement 21.8)', () => {
    // The destructive direction: for any click strictly above the 5% ceiling, the sample
    // step criterion must fire. Bounded below by the ceiling and above by full scale.
    fc.assert(
      fc.property(
        arbBpm,
        arbTimeSignature,
        fc.double({ min: 0.06, max: 1.0, noNaN: true }),
        (bpm, timeSignature, clickHeight) => {
          const loop = compliantLoop({ bpm, timeSignature, barCount: 4, amplitude: 0.5 });
          const channel = loop.audio.channels[0];
          if (channel === undefined) return;
          // Peak becomes the click itself when it exceeds the tone, so the ratio is
          // measured against `max(0.5, clickHeight)` — still above 5% either way.
          const clicked = withClickAt(channel, channel.length - 1, clickHeight);
          const verdict = evaluateLoopSeam(
            measureLoopSync({
              subject: { kind: 'pcm', audio: monoAudio(clicked, loop.audio.sampleRate) },
              bpm,
              timeSignature,
            }),
            thresholds,
          );

          expect(verdict.unmet).toContain('seam_sample_step');
          expect(verdict.satisfied).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('detects an edge dip for any fade longer than the edge window (Requirement 21.16)', () => {
    fc.assert(
      fc.property(
        arbBpm,
        arbTimeSignature,
        fc.integer({ min: 300, max: 900 }),
        (bpm, timeSignature, fadeMs) => {
          // 8 bars keeps the loop comfortably longer than the fade at every tempo.
          const loop = compliantLoop({ bpm, timeSignature, barCount: 8 });
          const channel = loop.audio.channels[0];
          if (channel === undefined) return;
          if (durationMs(loop.audio) < fadeMs * 3) return;

          const faded = withFadeIn(withFadeOut(channel, fadeMs), fadeMs);
          const verdict = evaluateLoopSeam(
            measureLoopSync({
              subject: { kind: 'pcm', audio: monoAudio(faded, loop.audio.sampleRate) },
              bpm,
              timeSignature,
            }),
            thresholds,
          );

          expect(verdict.unmet).toContain('edge_energy');
        },
      ),
      RUNS,
    );
  });

  it('is deterministic: the same samples always measure identically', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3_000 }), arbAmplitude, (frameCount, amplitude) => {
        const channel = sine(330, frameCount, amplitude);
        const audio = (): PcmAudio => monoAudio(Float32Array.from(channel));
        const query = { bpm: 120, timeSignature: 4 };

        expect(measureLoopSync({ subject: { kind: 'pcm', audio: audio() }, ...query })).toEqual(
          measureLoopSync({ subject: { kind: 'pcm', audio: audio() }, ...query }),
        );
      }),
      RUNS,
    );
  });
});

describe('loudness scaling underpins the intensity ladder (Requirement 21.11)', () => {
  it('moves loudness by exactly 20·log10(g) for any gain g', () => {
    // The relation the ladder rests on: an intensity step is a level step, and the
    // measurement must report a level step as the number of LU it is.
    fc.assert(
      fc.property(
        fc.double({ min: 0.02, max: 1, noNaN: true }),
        fc.double({ min: -18, max: 6, noNaN: true }),
        (amplitude, gainDb) => {
          const channel = sine(440, Math.round(TEST_SAMPLE_RATE * 1.5), amplitude);
          const gain = 10 ** (gainDb / 20);
          const before = integratedLoudnessLufs(monoAudio(channel));
          const after = integratedLoudnessLufs(monoAudio(scaled(channel, gain)));

          expect(after - before).toBeCloseTo(gainDb, 4);
        },
      ),
      RUNS,
    );
  });

  it('accepts every ladder the planner can produce (Requirements 21.9, 21.10, 21.11)', () => {
    // The plan satisfies the invariant by construction, so no count and no gap the
    // validator admits can produce a ladder the verifier then rejects.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.double({ min: 1, max: 6, noNaN: true }),
        fc.double({ min: -40, max: -8, noNaN: true }),
        (count, gapLufs, baseLoudnessLufs) => {
          const plan = planIntensityLadder({ count, gapLufs, baseLoudnessLufs });
          const verdict = verifyIntensityLadder(
            plan.map((entry) => ({
              assetId: `asset-${String(entry.step)}`,
              step: entry.step,
              durationMs: 8_000,
              integratedLoudnessLufs: entry.targetLoudnessLufs,
            })),
          );

          expect(verdict.satisfied).toBe(true);
          expect(verdict.unmet).toEqual([]);
        },
      ),
      RUNS,
    );
  });

  it('reports the amplitude difference symmetrically and finitely', () => {
    fc.assert(
      fc.property(arbLevel, arbLevel, (first, second) => {
        const forward = amplitudeDifferenceDb(first, second);
        const backward = amplitudeDifferenceDb(second, first);

        expect(forward).toBe(backward);
        expect(Number.isNaN(forward)).toBe(false);
        expect(forward).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });
});
