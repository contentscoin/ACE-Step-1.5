import { describe, expect, it } from 'vitest';

import { durationMs, frameCount } from '../../../domain/audio/pcm';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { dialogueTailSilenceThresholds } from '../../../domain/quality/speech-thresholds';
import {
  adjustTailSilence,
  evaluateTailSilence,
  measureTailSilence,
} from '../../../domain/speech/tail-silence';
import { frames, monoAudio, sine, stereoAudio, TEST_SAMPLE_RATE } from '../../support/pcm-synthesis';

/**
 * The trailing silence rule.
 *
 * **Validates: Requirements 25.19, 34.3, 34.6**
 *
 * The numbers under test are Quality_Threshold_Set members, so they are read from the set rather
 * than written as literals — a test that inlined -60 dBFS would pass even if the projection stopped
 * reading the set.
 */

const THRESHOLDS = dialogueTailSilenceThresholds(INITIAL_QUALITY_THRESHOLD_SET);

/** Speech of `spokenMs`, then exact silence of `silentMs`. */
function utterance(spokenMs: number, silentMs: number, sampleRate = TEST_SAMPLE_RATE) {
  const spokenFrames = Math.max(1, frames(spokenMs, sampleRate));
  const silentFrames = Math.max(0, frames(silentMs, sampleRate));
  const samples = new Float32Array(spokenFrames + silentFrames);
  samples.set(sine(220, spokenFrames, 0.6, sampleRate), 0);
  return monoAudio(samples, sampleRate);
}

describe('the initial values are Requirement 25.19 verbatim (Requirement 34.3)', () => {
  it('is -60 dBFS over a 50–200 ms window', () => {
    expect(THRESHOLDS.silenceFloorDbfs).toBe(-60);
    expect(THRESHOLDS.tailSilenceMinMs).toBe(50);
    expect(THRESHOLDS.tailSilenceMaxMs).toBe(200);
  });
});

describe('measuring backwards from the last sample (Requirement 25.19)', () => {
  it('measures the length of the trailing silent run', () => {
    const measured = measureTailSilence(utterance(500, 120), THRESHOLDS.silenceFloorDbfs);

    expect(measured.trailingSilenceMs).toBeCloseTo(120, 1);
  });

  it('stops at the first sample above the floor', () => {
    // A quiet tail at -40 dBFS is above the -60 dBFS floor, so it is not silence.
    const spokenFrames = frames(300);
    const samples = new Float32Array(spokenFrames + frames(200));
    samples.set(sine(220, spokenFrames, 0.6), 0);
    for (let index = spokenFrames; index < samples.length; index += 1) {
      samples[index] = index % 2 === 0 ? 0.01 : -0.01;
    }

    expect(measureTailSilence(monoAudio(samples), THRESHOLDS.silenceFloorDbfs).trailingSilenceMs).toBe(0);
  });

  it('measures a wholly silent buffer as its own length', () => {
    const silent = monoAudio(new Float32Array(frames(400)));

    expect(measureTailSilence(silent, THRESHOLDS.silenceFloorDbfs).trailingSilenceMs).toBeCloseTo(
      400,
      1,
    );
  });

  it('requires every channel to be silent for the frame to count', () => {
    const left = new Float32Array(frames(300));
    const right = new Float32Array(frames(300));
    left.set(sine(220, frames(100), 0.5), 0);
    // The right channel is still speaking through the left channel's silence.
    right.set(sine(220, frames(300), 0.5), 0);

    expect(
      measureTailSilence(stereoAudio(left, right), THRESHOLDS.silenceFloorDbfs).trailingSilenceMs,
    ).toBe(0);
  });
});

describe('the verdict (Requirement 25.19)', () => {
  it('is satisfied inside the window and asks for no adjustment', () => {
    for (const silentMs of [50, 120, 200]) {
      const verdict = evaluateTailSilence(
        measureTailSilence(utterance(400, silentMs), THRESHOLDS.silenceFloorDbfs),
        THRESHOLDS,
      );

      expect(verdict.satisfied).toBe(true);
      expect(verdict.adjustmentMs).toBe(0);
    }
  });

  it('asks for padding to the midpoint when the tail is short', () => {
    const verdict = evaluateTailSilence(
      measureTailSilence(utterance(400, 10), THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.targetMs).toBe(125);
    expect(verdict.adjustmentMs).toBeCloseTo(115, 1);
  });

  it('asks for trimming to the midpoint when the tail is long', () => {
    const verdict = evaluateTailSilence(
      measureTailSilence(utterance(400, 800), THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.adjustmentMs).toBeCloseTo(-675, 1);
  });

  it('records the set version it was taken against (Requirement 34.6)', () => {
    const verdict = evaluateTailSilence(
      measureTailSilence(utterance(400, 100), THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );

    expect(verdict.qualityThresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });
});

describe('the adjustment (Requirement 25.19)', () => {
  it('pads a short tail into the window', () => {
    const audio = utterance(400, 10);
    const verdict = evaluateTailSilence(
      measureTailSilence(audio, THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );
    const adjusted = adjustTailSilence(audio, verdict);
    const after = measureTailSilence(adjusted, THRESHOLDS.silenceFloorDbfs);

    expect(after.trailingSilenceMs).toBeGreaterThanOrEqual(THRESHOLDS.tailSilenceMinMs);
    expect(after.trailingSilenceMs).toBeLessThanOrEqual(THRESHOLDS.tailSilenceMaxMs);
    expect(durationMs(adjusted)).toBeGreaterThan(durationMs(audio));
  });

  it('trims a long tail into the window without touching the speech', () => {
    const audio = utterance(400, 900);
    const verdict = evaluateTailSilence(
      measureTailSilence(audio, THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );
    const adjusted = adjustTailSilence(audio, verdict);
    const after = measureTailSilence(adjusted, THRESHOLDS.silenceFloorDbfs);

    expect(after.trailingSilenceMs).toBeGreaterThanOrEqual(THRESHOLDS.tailSilenceMinMs);
    expect(after.trailingSilenceMs).toBeLessThanOrEqual(THRESHOLDS.tailSilenceMaxMs);
    // The 400 ms of speech survives: the trim only ever removes measured silence.
    expect(durationMs(adjusted)).toBeGreaterThan(400);
  });

  it('is idempotent — an adjusted asset is not adjusted again', () => {
    const audio = utterance(400, 10);
    const once = adjustTailSilence(
      audio,
      evaluateTailSilence(measureTailSilence(audio, THRESHOLDS.silenceFloorDbfs), THRESHOLDS),
    );
    const secondVerdict = evaluateTailSilence(
      measureTailSilence(once, THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );
    const twice = adjustTailSilence(once, secondVerdict);

    expect(secondVerdict.satisfied).toBe(true);
    expect(frameCount(twice)).toBe(frameCount(once));
  });

  it('never trims a buffer below one frame', () => {
    const silent = monoAudio(new Float32Array(frames(1_000)));
    const verdict = evaluateTailSilence(
      measureTailSilence(silent, THRESHOLDS.silenceFloorDbfs),
      THRESHOLDS,
    );

    expect(frameCount(adjustTailSilence(silent, verdict))).toBeGreaterThanOrEqual(1);
  });
});
