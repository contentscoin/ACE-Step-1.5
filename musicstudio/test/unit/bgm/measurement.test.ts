import { describe, expect, it } from 'vitest';

import { rmsOf } from '../../../domain/audio/level';
import { durationMs, windowSampleCount } from '../../../domain/audio/pcm';
import { BGM_EDGE_WINDOW_MS, BGM_SEAM_WINDOW_MS } from '../../../domain/bgm/bounds';
import { evaluateLoopSeam } from '../../../domain/bgm/loop-seam';
import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import {
  MeasurementUnsupportedError,
  type LoopMeasurementQuery,
} from '../../../services/sound/measurement';
import {
  createInProcessAudioMeasurement,
  measureLoopSync,
} from '../../../services/sound/in-process-measurement';
import {
  TEST_SAMPLE_RATE,
  compliantLoop,
  frames,
  monoAudio,
  scaled,
  sine,
  stereoAudio,
  withClickAt,
  withFadeIn,
  withFadeOut,
} from '../../support/pcm-synthesis';

/**
 * The measurement half of Requirement 21's loop criteria, against synthesised PCM.
 *
 * **Validates: Requirements 21.7, 21.8, 21.15, 21.16, 21.17**
 *
 * Every buffer is generated in TypeScript from a closed-form expression, so each expected
 * value is derived rather than recorded. The three probes design §5.3 implies are all
 * here: a **sine** whose whole-cycle length makes a continuous seam, a **click** that
 * breaks the sample-step rule and nothing else, and a **fade** that breaks the
 * edge-energy rule and nothing else.
 *
 * The measurements are genuinely computed — no stub, no fixture. Task 3.1's Python worker
 * will compute the same quantities with `librosa`/`pyloudnorm` behind the same port; the
 * shared reference is BS.1770-4 and the arithmetic below, not either implementation.
 */

const thresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);

const LOOP_BPM = 120;
const LOOP_TIME_SIGNATURE = 4;

function query(overrides: Partial<LoopMeasurementQuery> & Pick<LoopMeasurementQuery, 'subject'>) {
  return {
    bpm: LOOP_BPM,
    timeSignature: LOOP_TIME_SIGNATURE,
    ...overrides,
  } satisfies LoopMeasurementQuery;
}

describe('window sizing (Requirement 21.7)', () => {
  it('derives the window from the stored sample rate, not from 48 kHz', () => {
    // 10 ms is 480 samples at 48 kHz and 441 at 44.1 kHz. Rounding rather than
    // truncating is what makes the second of those 441 and not 440.
    expect(windowSampleCount(48_000, BGM_SEAM_WINDOW_MS)).toBe(480);
    expect(windowSampleCount(44_100, BGM_SEAM_WINDOW_MS)).toBe(441);
    expect(windowSampleCount(44_100, BGM_EDGE_WINDOW_MS)).toBe(4_410);
  });

  it('never asks for fewer than one sample', () => {
    expect(windowSampleCount(48_000, 0)).toBe(1);
  });
});

describe('a whole-cycle sine loop (Requirements 21.7, 21.8, 21.16, 21.17)', () => {
  const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });

  it('is 4 bars long at 120 BPM in 4/4, so 8000 ms', () => {
    expect(durationMs(loop.audio)).toBeCloseTo(8_000, 6);
  });

  it('measures equal RMS in the 10 ms windows at each end', () => {
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio: loop.audio } }));
    const channel = measurement.channels[0];

    expect(channel).toBeDefined();
    expect(channel?.tailSeamRms).toBeCloseTo(channel?.headSeamRms ?? 0, 6);
  });

  it('measures a seam step of about 1.3% of the peak — one sample of slope', () => {
    // The loop ends a whole number of cycles from phase 0, so the last sample sits one
    // sampling interval short of the first. That step is `amplitude · sin(2πf/fs)`, which
    // for a 100 Hz tone at 48 kHz is 1.31% of the amplitude.
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio: loop.audio } }));
    const channel = measurement.channels[0];
    const expectedStep = Math.abs(Math.sin((2 * Math.PI * loop.frequencyHz) / TEST_SAMPLE_RATE));

    expect(
      Math.abs((channel?.lastSample ?? 0) - (channel?.firstSample ?? 0)) / (channel?.peakAbs ?? 1),
    ).toBeCloseTo(expectedStep, 3);
    expect(expectedStep).toBeLessThan(thresholds.seamSampleStepRatioMax);
  });

  it('measures both 100 ms edge windows at the overall level', () => {
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio: loop.audio } }));
    const channel = measurement.channels[0];

    expect(channel?.headEdgeRms).toBeCloseTo(channel?.overallRms ?? 0, 4);
    expect(channel?.tailEdgeRms).toBeCloseTo(channel?.overallRms ?? 0, 4);
  });

  it('satisfies all four criteria end to end', () => {
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio: loop.audio } }));
    const verdict = evaluateLoopSeam(measurement, thresholds);

    expect(verdict.unmet).toEqual([]);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.barAlignment.barCount).toBe(4);
  });

  it('records the loudness Requirement 21.15 stores', () => {
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio: loop.audio } }));

    expect(Number.isFinite(measurement.integratedLoudnessLufs)).toBe(true);
    expect(measurement.sampleRate).toBe(TEST_SAMPLE_RATE);
  });
});

describe('a click at the seam (Requirement 21.8)', () => {
  const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });
  const channel = loop.audio.channels[0] ?? new Float32Array(0);
  // A single sample driven to full scale at the very end: a real seam discontinuity.
  const clicked = monoAudio(withClickAt(channel, channel.length - 1, 1.0));

  it('breaks the sample-step criterion and only that one', () => {
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: clicked } })),
      thresholds,
    );

    expect(verdict.unmet).toEqual(['seam_sample_step']);
  });

  it('measures the step as the click height over the new peak', () => {
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio: clicked } }));
    const measured = measurement.channels[0];

    expect(measured?.lastSample).toBeCloseTo(1.0, 6);
    expect(measured?.peakAbs).toBeCloseTo(1.0, 6);
  });

  it('is caught even when it is only just over the 5% ceiling', () => {
    // The click that matters is not the obvious one. 5.5% of the peak is inaudible as a
    // sample but audible as a periodic tick once the loop repeats.
    const amplitude = 0.5;
    const justOver = monoAudio(
      withClickAt(channel, channel.length - 1, amplitude * 0.056 + (channel[0] ?? 0)),
    );
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: justOver } })),
      thresholds,
    );

    expect(verdict.unmet).toContain('seam_sample_step');
  });
});

describe('a fade at either end (Requirement 21.16)', () => {
  const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });
  const channel = loop.audio.channels[0] ?? new Float32Array(0);

  /** Long enough that the whole 100 ms edge window sits inside the ramp. */
  const DEEP_FADE_MS = 400;

  it('breaks the edge-energy criterion and only that one, given symmetric fades', () => {
    // Symmetric fades are the interesting case: the two 10 ms seam windows are equally
    // quiet so Requirement 21.7 is satisfied, the first and last samples are both 0 so
    // Requirement 21.8 is satisfied, the length is untouched so Requirement 21.17 is
    // satisfied — and the loop still audibly dips every time it comes round, which is
    // exactly the artefact Requirement 21.16 exists to catch.
    const faded = monoAudio(withFadeIn(withFadeOut(channel, DEEP_FADE_MS), DEEP_FADE_MS));
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: faded } })),
      thresholds,
    );

    expect(verdict.unmet).toEqual(['edge_energy']);
    expect(verdict.channels[0]?.headEdgeRelativeDb).toBeLessThan(-6);
    expect(verdict.channels[0]?.tailEdgeRelativeDb).toBeLessThan(-6);
  });

  it('breaks it on a fade-out alone, alongside the seam RMS jump', () => {
    // A one-sided fade fails two criteria at once, and correctly so: a full-level head
    // against a silent tail is both an edge dip and a level discontinuity at the seam.
    const faded = monoAudio(withFadeOut(channel, DEEP_FADE_MS));
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: faded } })),
      thresholds,
    );

    expect(verdict.unmet).toContain('edge_energy');
    expect(verdict.unmet).toContain('seam_rms_difference');
    expect(verdict.channels[0]?.tailEdgeRelativeDb).toBeLessThan(-6);
    expect(verdict.channels[0]?.headEdgeRelativeDb).toBeGreaterThan(-6);
  });

  it('breaks it on a fade-in alone, at the head only', () => {
    const faded = monoAudio(withFadeIn(channel, DEEP_FADE_MS));
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: faded } })),
      thresholds,
    );

    expect(verdict.unmet).toContain('edge_energy');
    expect(verdict.channels[0]?.headEdgeRelativeDb).toBeLessThan(-6);
    expect(verdict.channels[0]?.tailEdgeRelativeDb).toBeGreaterThan(-6);
  });

  it('tolerates a fade short enough to leave the 100 ms window mostly intact', () => {
    // A 5 ms fade is a de-click, not a musical fade: the 100 ms edge window is still
    // within 6 dB of the overall level, so the criterion must not fire.
    const faded = monoAudio(withFadeOut(channel, 5));
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: faded } })),
      thresholds,
    );

    expect(verdict.unmet).not.toContain('edge_energy');
  });

  it('tolerates a fade exactly as long as the edge window, at -4.77 dB', () => {
    // A linear ramp from 1 to 0 across the whole window has RMS `1/√3` of the un-faded
    // level — 4.77 dB down, which is *inside* the 6 dB floor. So a 100 ms fade does not
    // break Requirement 21.16, and the failing cases above need a longer ramp. Worth
    // pinning: it is the boundary that decides how deep a fade the rule actually catches.
    const faded = withFadeOut(channel, BGM_EDGE_WINDOW_MS);
    const tail = faded.slice(faded.length - frames(BGM_EDGE_WINDOW_MS));
    const relativeDb = 20 * Math.log10(rmsOf(tail) / rmsOf(channel));

    expect(relativeDb).toBeCloseTo(20 * Math.log10(1 / Math.sqrt(3)), 1);
    expect(relativeDb).toBeGreaterThan(thresholds.edgeEnergyFloorDb);
    expect(
      evaluateLoopSeam(
        measureLoopSync(query({ subject: { kind: 'pcm', audio: monoAudio(faded) } })),
        thresholds,
      ).unmet,
    ).not.toContain('edge_energy');
  });
});

describe('bar misalignment (Requirement 21.17)', () => {
  it('fails a loop whose length is not a whole number of bars', () => {
    // 3.5 bars at 120 BPM 4/4 is 7000 ms — a clean seam and a drifting loop.
    const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });
    const channel = loop.audio.channels[0] ?? new Float32Array(0);
    const shortened = monoAudio(channel.slice(0, frames(7_000)));

    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: shortened } })),
      thresholds,
    );

    expect(verdict.unmet).toContain('bar_alignment');
    expect(verdict.barAlignment.errorMs).toBeGreaterThan(
      thresholds.barAlignmentToleranceMs,
    );
  });

  it('judges against the engine-reported tempo, not the requested one', () => {
    // Requirement 21.17 computes the bar from the *recorded* BPM. The same 8000 ms audio
    // is 4 bars at 120 BPM and 5.33 bars at 160, so the verdict must differ.
    const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });
    const subject = { kind: 'pcm' as const, audio: loop.audio };

    expect(
      evaluateLoopSeam(measureLoopSync(query({ subject })), thresholds).unmet,
    ).not.toContain('bar_alignment');
    expect(
      evaluateLoopSeam(measureLoopSync(query({ subject, bpm: 160 })), thresholds).unmet,
    ).toContain('bar_alignment');
  });
});

describe('per-channel measurement (Requirements 21.7, 21.8, 21.16)', () => {
  it('measures each channel of a stereo asset independently', () => {
    const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });
    const left = loop.audio.channels[0] ?? new Float32Array(0);
    const right = scaled(left, 0.25);
    const measurement = measureLoopSync(
      query({ subject: { kind: 'pcm', audio: stereoAudio(left, right) } }),
    );

    expect(measurement.channels).toHaveLength(2);
    // Each channel's peak is its own, which is what makes the 21.8 ratio per channel.
    expect(measurement.channels[1]?.peakAbs).toBeCloseTo(
      (measurement.channels[0]?.peakAbs ?? 0) * 0.25,
      6,
    );
  });

  it('fails a stereo loop when only the right channel has the fault', () => {
    const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });
    const left = loop.audio.channels[0] ?? new Float32Array(0);
    const right = withFadeOut(left, 200);
    const verdict = evaluateLoopSeam(
      measureLoopSync(query({ subject: { kind: 'pcm', audio: stereoAudio(left, right) } })),
      thresholds,
    );

    expect(verdict.unmet).toContain('edge_energy');
  });
});

describe('short and degenerate audio', () => {
  it('measures a 5-second asset with a 100 ms edge window (Requirement 21.2)', () => {
    const audio = monoAudio(sine(100, frames(5_000), 0.5));
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio } }));

    expect(measurement.durationMs).toBeCloseTo(5_000, 6);
    expect(Number.isFinite(measurement.channels[0]?.headEdgeRms ?? NaN)).toBe(true);
  });

  it('collapses a window longer than the buffer rather than reading out of bounds', () => {
    // A 50 ms buffer has no distinct 100 ms edges. Both windows become the whole buffer,
    // which measures the overall RMS — a relative level of 0 dB, and no false failure.
    const audio = monoAudio(sine(100, frames(50), 0.5));
    const measurement = measureLoopSync(query({ subject: { kind: 'pcm', audio } }));
    const channel = measurement.channels[0];

    expect(channel?.headEdgeRms).toBeCloseTo(channel?.overallRms ?? 0, 12);
    expect(channel?.tailEdgeRms).toBeCloseTo(channel?.overallRms ?? 0, 12);
  });

  it('measures a single-sample buffer without producing NaN', () => {
    const measurement = measureLoopSync(
      query({ subject: { kind: 'pcm', audio: monoAudio(Float32Array.from([0.25])) } }),
    );
    const channel = measurement.channels[0];

    expect(channel?.firstSample).toBeCloseTo(0.25, 6);
    expect(channel?.lastSample).toBeCloseTo(0.25, 6);
    expect(channel?.overallRms).toBeCloseTo(0.25, 6);
  });
});

describe('the port contract (integration point for task 3.1)', () => {
  const measurement = createInProcessAudioMeasurement();
  const loop = compliantLoop({ bpm: LOOP_BPM, timeSignature: LOOP_TIME_SIGNATURE, barCount: 4 });

  it('answers measureLoop, measureLoudnessLufs and measureShape from PCM', async () => {
    const subject = { kind: 'pcm' as const, audio: loop.audio };

    await expect(measurement.measureLoop(query({ subject }))).resolves.toMatchObject({
      sampleRate: TEST_SAMPLE_RATE,
      bpm: LOOP_BPM,
    });
    await expect(measurement.measureLoudnessLufs(subject)).resolves.toBeLessThan(0);
    await expect(measurement.measureShape(subject)).resolves.toEqual({
      durationMs: 8_000,
      sampleRate: TEST_SAMPLE_RATE,
      channels: 1,
    });
  });

  it('refuses a stored subject rather than pretending it can read storage', async () => {
    // The seam stays honest: reading an object key is task 3.1's, and the in-process
    // measurer says so instead of silently returning zeros.
    await expect(
      measurement.measureLoudnessLufs({ kind: 'stored', objectKey: 'bgm/loop.wav' }),
    ).rejects.toBeInstanceOf(MeasurementUnsupportedError);
  });

  it('is deterministic across repeated measurements of the same audio', async () => {
    const subject = { kind: 'pcm' as const, audio: loop.audio };
    const first = await measurement.measureLoop(query({ subject }));
    const second = await measurement.measureLoop(query({ subject }));

    expect(second).toEqual(first);
  });
});
