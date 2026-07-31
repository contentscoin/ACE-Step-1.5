import { describe, expect, it } from 'vitest';

import {
  barDurationMs,
  evaluateBarAlignment,
  nearestAlignedDurationMs,
} from '../../../domain/bgm/bar-alignment';
import {
  BGM_LOOP_BAR_MULTIPLE_MAX,
  BGM_REFERENCE_BPM_TOLERANCE,
} from '../../../domain/bgm/bounds';
import { BGM_METADATA_FIELDS, compareToReference } from '../../../domain/bgm/metadata';
import { INSTRUMENTAL_LYRICS } from '../../../domain/song/request';
import { bgmSongRequest } from '../../../domain/bgm/song-request';
import { validateBgmRequest } from '../../../domain/bgm/validation';
import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { bgmMetadata, referenceAgreementFor } from '../../../services/sound/bgm-result';
import type { BgmCandidate } from '../../../services/sound/bgm-ports';
import type { LoopMeasurement } from '../../../domain/bgm/loop-seam';
import { compliantLoop } from '../../support/pcm-synthesis';

/**
 * The metadata a completed `bgm` asset carries, and the bar arithmetic behind it.
 *
 * **Validates: Requirements 21.4, 21.13, 21.14, 21.15, 21.17, 34.6**
 */

const thresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);

function candidate(overrides: Partial<BgmCandidate> = {}): BgmCandidate {
  return {
    jobId: 'job-1',
    assetId: 'bgm-asset-1',
    audio: compliantLoop({ bpm: 120, timeSignature: 4, barCount: 4 }).audio,
    bpm: 120,
    keyScale: 'C major',
    timeSignature: 4,
    seed: 42,
    ...overrides,
  };
}

function measurement(overrides: Partial<LoopMeasurement> = {}): LoopMeasurement {
  return {
    sampleRate: 48_000,
    channels: [
      {
        headSeamRms: 0.5,
        tailSeamRms: 0.5,
        headEdgeRms: 0.5,
        tailEdgeRms: 0.5,
        overallRms: 0.5,
        firstSample: 0,
        lastSample: 0,
        peakAbs: 0.5,
      },
    ],
    durationMs: 8_000,
    bpm: 120,
    timeSignature: 4,
    integratedLoudnessLufs: -18.5,
    ...overrides,
  };
}

function parameters(loop: boolean) {
  const result = validateBgmRequest({
    sceneDescription: 'a windswept ridge at dawn',
    targetLengthSeconds: 8,
    loop,
  });
  if (result.kind !== 'valid') throw new Error('expected a valid request');
  return result.parameters;
}

describe('bar arithmetic (Requirement 21.17)', () => {
  it('computes one bar as 60000/BPM per beat times the beats per bar', () => {
    expect(barDurationMs(120, 4)).toBe(2_000);
    expect(barDurationMs(120, 3)).toBe(1_500);
    expect(barDurationMs(60, 4)).toBe(4_000);
    expect(barDurationMs(90, 6)).toBeCloseTo(4_000, 10);
  });

  it('treats a nonsensical tempo as unmeasurable rather than dividing by zero', () => {
    for (const [bpm, timeSignature] of [
      [0, 4],
      [-120, 4],
      [120, 0],
      [Number.NaN, 4],
    ]) {
      expect(barDurationMs(bpm ?? 0, timeSignature ?? 0)).toBe(Number.POSITIVE_INFINITY);
      expect(
        evaluateBarAlignment({
          durationMs: 8_000,
          bpm: bpm ?? 0,
          timeSignature: timeSignature ?? 0,
          toleranceMs: 25,
        }).aligned,
      ).toBe(false);
    }
  });

  it('rounds to the nearest multiple, making the tolerance two-sided', () => {
    // A loop 5 ms short of eight bars is eight bars with a 5 ms error, not seven bars
    // with a large one.
    const alignment = evaluateBarAlignment({
      durationMs: 15_995,
      bpm: 120,
      timeSignature: 4,
      toleranceMs: 25,
    });

    expect(alignment.barCount).toBe(8);
    expect(alignment.errorMs).toBe(5);
    expect(alignment.aligned).toBe(true);
  });

  it('accepts 1 bar and 64 bars, and refuses 65', () => {
    for (const barCount of [1, 32, BGM_LOOP_BAR_MULTIPLE_MAX]) {
      expect(
        evaluateBarAlignment({
          durationMs: barCount * 2_000,
          bpm: 120,
          timeSignature: 4,
          toleranceMs: 25,
        }).aligned,
      ).toBe(true);
    }

    expect(
      evaluateBarAlignment({
        durationMs: 65 * 2_000,
        bpm: 120,
        timeSignature: 4,
        toleranceMs: 25,
      }).aligned,
    ).toBe(false);
  });

  it('reads the tolerance from its argument, not from a literal', () => {
    const input = { durationMs: 8_040, bpm: 120, timeSignature: 4 };

    expect(evaluateBarAlignment({ ...input, toleranceMs: 25 }).aligned).toBe(false);
    expect(evaluateBarAlignment({ ...input, toleranceMs: 50 }).aligned).toBe(true);
  });

  it('suggests the nearest aligned duration, clamped into the 1–64 bar range', () => {
    expect(nearestAlignedDurationMs(7_400, 120, 4)).toBe(8_000);
    // A 1 ms request cannot be less than one bar.
    expect(nearestAlignedDurationMs(1, 120, 4)).toBe(2_000);
    // A 10-minute request at 120 BPM is more than 64 bars, so it clamps to 64.
    expect(nearestAlignedDurationMs(600_000, 120, 4)).toBe(64 * 2_000);
  });
});

describe('stored metadata (Requirements 21.15, 21.4, 34.6)', () => {
  it('records all ten fields Requirement 21.15 lists', () => {
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement(),
      parameters: parameters(true),
      thresholds,
      verdict: null,
    });

    for (const field of BGM_METADATA_FIELDS) {
      expect(metadata[field]).toBeDefined();
    }
    expect(metadata).toMatchObject({
      bpm: 120,
      keyScale: 'C major',
      timeSignature: 4,
      intensityStep: 1,
      isLoop: true,
      sampleRate: 48_000,
      channels: 1,
      durationMs: 8_000,
      barCount: 4,
      integratedLoudnessLufs: -18.5,
    });
  });

  it('records the lyrics metadata as empty, not absent (Requirement 21.4)', () => {
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement(),
      parameters: parameters(false),
      thresholds,
      verdict: null,
    });

    expect(metadata.lyrics).toBe('');
    expect(Object.hasOwn(metadata, 'lyrics')).toBe(true);
  });

  it('records the threshold set version it was judged against (Requirement 34.6)', () => {
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement(),
      parameters: parameters(true),
      thresholds,
      verdict: null,
    });

    expect(metadata.qualityThresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('records the engine-chosen tempo, not the requested one', () => {
    // Requirement 4.7 lets the engine pick what the caller omitted, and Requirements
    // 21.13 and 21.17 both judge against what it picked.
    const metadata = bgmMetadata({
      candidate: candidate({ bpm: 128, keyScale: 'F minor', timeSignature: 3 }),
      measurement: measurement({ bpm: 128, timeSignature: 3 }),
      parameters: parameters(true),
      thresholds,
      verdict: null,
    });

    expect(metadata.bpm).toBe(128);
    expect(metadata.keyScale).toBe('F minor');
    expect(metadata.timeSignature).toBe(3);
  });

  it('records a bar count for a non-loop asset too', () => {
    // 21.15 lists 마디 수 unconditionally. The difference between a loop and a non-loop
    // asset is whether that count had to be exact, not whether it exists.
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement({ durationMs: 7_300 }),
      parameters: parameters(false),
      thresholds,
      verdict: null,
    });

    expect(metadata.isLoop).toBe(false);
    expect(metadata.barCount).toBe(4);
  });

  it('records the intensity step when the cue is part of a ladder', () => {
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement(),
      parameters: parameters(true),
      thresholds,
      verdict: null,
      intensityStep: 3,
    });

    expect(metadata.intensityStep).toBe(3);
  });

  it('rounds the duration to whole milliseconds', () => {
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement({ durationMs: 8_000.4 }),
      parameters: parameters(true),
      thresholds,
      verdict: null,
    });

    expect(metadata.durationMs).toBe(8_000);
  });
});

describe('reference agreement (Requirements 21.12, 21.13)', () => {
  it('accepts a BPM within ±1 of the reference and an identical key', () => {
    for (const bpm of [127, 128, 129]) {
      expect(
        compareToReference({ bpm, keyScale: 'F major' }, { bpm: 128, keyScale: 'F major' },
          BGM_REFERENCE_BPM_TOLERANCE),
      ).toEqual({ bpmDeltaAbsolute: Math.abs(bpm - 128), bpmWithinTolerance: true, keyIdentical: true });
    }
  });

  it('refuses a BPM more than 1 away', () => {
    expect(
      compareToReference({ bpm: 130, keyScale: 'F major' }, { bpm: 128, keyScale: 'F major' },
        BGM_REFERENCE_BPM_TOLERANCE).bpmWithinTolerance,
    ).toBe(false);
  });

  it('requires the key to be identical, not merely close', () => {
    // 21.13 says "동일한 값" for the key, with no tolerance — a relative minor is a
    // different key.
    expect(
      compareToReference({ bpm: 128, keyScale: 'D minor' }, { bpm: 128, keyScale: 'F major' },
        BGM_REFERENCE_BPM_TOLERANCE).keyIdentical,
    ).toBe(false);
  });

  it('reports no agreement at all when no reference was named', () => {
    const metadata = bgmMetadata({
      candidate: candidate(),
      measurement: measurement(),
      parameters: parameters(true),
      thresholds,
      verdict: null,
    });

    expect(referenceAgreementFor(metadata, undefined)).toBeNull();
    expect(
      referenceAgreementFor(metadata, { assetId: 'ref-1', bpm: 120, keyScale: 'C major' }),
    ).toMatchObject({ bpmWithinTolerance: true, keyIdentical: true });
  });
});

describe('the engine request reuses Custom_Mode (Requirements 21.4, design §3.6)', () => {
  it('builds a Custom_Mode song request with the vocal side pinned shut', () => {
    const request = bgmSongRequest(parameters(true));

    expect(request).toMatchObject({
      mode: 'custom',
      instrumental: true,
      lyrics: INSTRUMENTAL_LYRICS,
      durationSeconds: 8,
      // Requirement 21.9's variants are separate requests, not one batch: a batch would
      // share every parameter and could not carry a per-variant intensity step.
      batchSize: 1,
    });
  });

  it('takes the attempt seed in preference to the request seed (Requirement 21.18)', () => {
    const withSeed = validateBgmRequest({
      sceneDescription: 'a windswept ridge at dawn',
      targetLengthSeconds: 8,
      seed: 7,
    });
    if (withSeed.kind !== 'valid') throw new Error('expected a valid request');

    expect(bgmSongRequest(withSeed.parameters).seed).toBe(7);
    expect(bgmSongRequest(withSeed.parameters, { seed: 91 }).seed).toBe(91);
  });

  it('omits BPM, key and time signature when the request left them to the engine', () => {
    const request = bgmSongRequest(parameters(true));

    expect(request.bpm).toBeUndefined();
    expect(request.keyScale).toBeUndefined();
    expect(request.timeSignature).toBeUndefined();
  });
});
