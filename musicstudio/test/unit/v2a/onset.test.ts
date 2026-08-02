import { describe, expect, it } from 'vitest';

import { thresholdValue, INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { v2aOnsetAlignmentThresholds } from '../../../domain/quality/v2a-thresholds';
import { V2A_ONSET_FRAME_MS, V2A_ONSET_LOOKBACK_MS } from '../../../domain/v2a/bounds';
import { detectOnsets, frameEnergies, onsetTimesMs, riseAt } from '../../../domain/v2a/onset';
import { TEST_SAMPLE_RATE, frames, monoAudio, sine, stereoAudio } from '../../support/pcm-synthesis';
import { ambienceAudio, foleyAudio } from '../../support/v2a-synthesis';

/**
 * Onset detection on produced audio — the measurement Requirement 23.8 defines.
 *
 * **Validates: Requirements 23.8, 34.1, 34.6**
 *
 * "산출 오디오의 온셋은 5밀리초 프레임 단위 단기 RMS가 직전 50밀리초 평균 RMS보다 6.0데시벨 이상
 * 큰 최초 프레임의 시작 시각으로 측정한다". Every case here is built from a synthesised buffer whose
 * impact times are *known*, so the detector is checked against an independent prediction rather
 * than against itself.
 *
 * The rise threshold arrives from the Quality_Threshold_Set and never as a literal, which is why
 * these tests read it through `v2aOnsetAlignmentThresholds` too.
 */

const THRESHOLDS = v2aOnsetAlignmentThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const OPTIONS = { riseDb: THRESHOLDS.onsetRiseDb };

/** Requirement 23.8's initial 6.0 dB, read from the set rather than restated. */
describe('the threshold comes from the Quality_Threshold_Set (Requirement 34.1)', () => {
  it('is 6.0 dB initially, with 0.50 as the confidence floor', () => {
    expect(thresholdValue(INITIAL_QUALITY_THRESHOLD_SET, 'v2a_onset_rise_db')).toBe(6.0);
    expect(THRESHOLDS.onsetRiseDb).toBe(6.0);
    expect(THRESHOLDS.visualEventConfidenceMin).toBe(0.5);
    expect(THRESHOLDS.alignmentToleranceMs).toBe(80);
    expect(THRESHOLDS.alignmentRateMin).toBe(0.9);
    expect(THRESHOLDS.version).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });
});

describe('short-term frames (Requirement 23.8)', () => {
  it('measures one RMS value per 5 ms frame', () => {
    const audio = ambienceAudio(1_000);
    // 1000 ms / 5 ms = 200 frames.
    expect(frameEnergies(audio)).toHaveLength(200);
    expect(frameEnergies(audio, V2A_ONSET_FRAME_MS)).toHaveLength(200);
  });

  it('takes the loudest channel, so a hard-panned transient is not halved', () => {
    const loud = new Float32Array(frames(50)).fill(0.8);
    const quiet = new Float32Array(frames(50));
    const energies = frameEnergies(stereoAudio(loud, quiet));

    // A mean across channels would report 0.4; the loudest channel reports 0.8.
    expect(energies[0]).toBeCloseTo(0.8, 6);
  });

  it('answers with nothing for an audio with no channels or no rate', () => {
    expect(frameEnergies({ sampleRate: TEST_SAMPLE_RATE, channels: [] })).toEqual([]);
    expect(frameEnergies({ sampleRate: 0, channels: [new Float32Array(10)] })).toEqual([]);
  });
});

describe('the rise (Requirement 23.8)', () => {
  const lookbackFrames = V2A_ONSET_LOOKBACK_MS / V2A_ONSET_FRAME_MS;

  it('is the dB difference from the average of the preceding 50 ms', () => {
    // Ten frames at 0.01 then one at 0.1: exactly 20 dB.
    const energies = [...Array.from({ length: lookbackFrames }, () => 0.01), 0.1];

    expect(riseAt(energies, lookbackFrames, lookbackFrames)).toBeCloseTo(20, 6);
  });

  it('is infinite out of silence, which is the only answer that detects the transient', () => {
    expect(riseAt([0, 0, 0.5], 2, lookbackFrames)).toBe(Number.POSITIVE_INFINITY);
    // Frame 0 has no history at all, so a non-silent first frame is an onset.
    expect(riseAt([0.5], 0, lookbackFrames)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is zero between two silent frames, so silence never reads as an onset', () => {
    expect(riseAt([0, 0, 0], 2, lookbackFrames)).toBe(0);
  });

  it('is negative infinity into silence, never NaN', () => {
    expect(riseAt([0.5, 0.5, 0], 2, lookbackFrames)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('uses the history it has before a full 50 ms is available', () => {
    // One preceding frame at 0.01, current 0.1 → 20 dB, even though only 5 ms of history exists.
    expect(riseAt([0.01, 0.1], 1, lookbackFrames)).toBeCloseTo(20, 6);
  });
});

describe('detected onsets (Requirement 23.8)', () => {
  it('reports the start time of the qualifying frame, one onset per impact', () => {
    const audio = foleyAudio({ durationMs: 2_000, impactTimesMs: [300, 800, 1_500] });
    const times = onsetTimesMs(audio, OPTIONS);

    // The bed is non-zero, so frame 0 is an onset out of silence; then one per impact.
    expect(times[0]).toBe(0);
    for (const impact of [300, 800, 1_500]) {
      const nearest = times.reduce(
        (best, time) => (Math.abs(time - impact) < Math.abs(best - impact) ? time : best),
        times[0] ?? 0,
      );
      // Frames are 5 ms, so the reported start is at most one frame early.
      expect(nearest).toBeGreaterThanOrEqual(impact - V2A_ONSET_FRAME_MS);
      expect(nearest).toBeLessThanOrEqual(impact + V2A_ONSET_FRAME_MS);
    }
    // One onset for the start of the buffer plus one per impact, and no more.
    expect(times).toHaveLength(4);
  });

  it('lands on a frame boundary, since 23.8 asks for the frame start', () => {
    for (const onset of detectOnsets(
      foleyAudio({ durationMs: 1_000, impactTimesMs: [402, 703] }),
      OPTIONS,
    )) {
      expect(onset.timeMs % V2A_ONSET_FRAME_MS).toBe(0);
      expect(onset.timeMs).toBe(onset.frameIndex * V2A_ONSET_FRAME_MS);
    }
  });

  it('is a rising-edge detector, not one onset per qualifying frame', () => {
    // A sustained crescendo would register hundreds of onsets per second under a literal
    // reading of "최초 프레임"; the documented reading gives at most the leading edge.
    const frameCount = frames(1_000);
    const samples = new Float32Array(frameCount);
    for (let index = 0; index < frameCount; index += 1) {
      samples[index] = (0.001 + (0.5 * index) / frameCount) * (index % 2 === 0 ? 1 : -1);
    }

    expect(onsetTimesMs(monoAudio(samples), OPTIONS).length).toBeLessThanOrEqual(2);
  });

  it('finds no onset in a steady tone after its start', () => {
    const times = onsetTimesMs(monoAudio(sine(220, frames(1_000), 0.5)), OPTIONS);

    // The tone begins from nothing, so its first frame qualifies; nothing after it does.
    expect(times).toEqual([0]);
  });

  it('finds nothing in digital silence', () => {
    expect(onsetTimesMs(monoAudio(new Float32Array(frames(1_000))), OPTIONS)).toEqual([]);
  });

  it('detects an impact on the first video frame, which is the commonest foley case', () => {
    const times = onsetTimesMs(foleyAudio({ durationMs: 1_000, impactTimesMs: [0] }), OPTIONS);

    expect(times[0]).toBe(0);
  });

  it('reports how far each onset rose, so a diagnosis is possible', () => {
    const onsets = detectOnsets(
      foleyAudio({ durationMs: 1_000, impactTimesMs: [500] }),
      OPTIONS,
    );
    const impact = onsets.find((onset) => onset.timeMs >= 495 && onset.timeMs <= 505);

    expect(impact?.riseDb).toBeGreaterThan(THRESHOLDS.onsetRiseDb);
    expect(Number.isFinite(impact?.riseDb ?? Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('honours a raised threshold, so the number is genuinely read from the set', () => {
    // A 6 dB step above the bed: detected at 6.0 dB, missed at 20 dB.
    const frameCount = frames(1_000);
    const samples = new Float32Array(frameCount);
    const stepAt = frames(500);
    for (let index = 0; index < frameCount; index += 1) {
      const level = index < stepAt ? 0.1 : 0.2;
      samples[index] = level * (index % 2 === 0 ? 1 : -1);
    }
    const audio = monoAudio(samples);

    expect(onsetTimesMs(audio, { riseDb: 6.0 })).toContain(500);
    expect(onsetTimesMs(audio, { riseDb: 20.0 })).not.toContain(500);
  });
});
