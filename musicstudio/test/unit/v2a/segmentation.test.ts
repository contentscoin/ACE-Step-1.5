import { describe, expect, it } from 'vitest';

import { peakAbs } from '../../../domain/audio/level';
import { durationMs, frameCount, type PcmAudio } from '../../../domain/audio/pcm';
import { V2A_SEGMENT_MAX_MS, V2A_SEGMENT_OVERLAP_MS } from '../../../domain/v2a/bounds';
import {
  SegmentJoinError,
  crossfadeJoin,
  hasStatedOverlaps,
  joinedDurationMs,
  lastSegmentExceedsOverlap,
  respectsSegmentCeiling,
  segmentPlan,
} from '../../../domain/v2a/segmentation';
import { TEST_SAMPLE_RATE, frames, monoAudio, sine } from '../../support/pcm-synthesis';

/**
 * Splitting a clip into engine-sized segments and joining what comes back.
 *
 * **Validates: Requirements 23.7, 23.9**
 *
 * 23.7 makes three claims in one sentence — every segment ≤8 s, adjacent segments overlap by
 * exactly 50 ms, joined length equals input length — and they are not independent: the third
 * follows from the first two only if the segments advance by 7950 ms and the join consumes each
 * overlap exactly once. So the length identity is asserted for its own sake, and each of the
 * other two separately, rather than one being trusted to imply the others.
 */

const ADVANCE_MS = V2A_SEGMENT_MAX_MS - V2A_SEGMENT_OVERLAP_MS;

/** A constant-magnitude buffer, so a crossfade region is visible in the samples. */
function flat(durationMsValue: number, value: number): PcmAudio {
  const samples = new Float32Array(Math.max(1, frames(durationMsValue)));
  samples.fill(value);
  return monoAudio(samples);
}

describe('the split (Requirement 23.7)', () => {
  it('leaves a clip inside one segment whole, with no overlap to consume', () => {
    for (const total of [500, 2_000, V2A_SEGMENT_MAX_MS]) {
      const plan = segmentPlan(total);

      expect(plan.segments).toHaveLength(1);
      expect(plan.segments[0]).toEqual({
        index: 0,
        startMs: 0,
        endMs: total,
        durationMs: total,
      });
      expect(joinedDurationMs(plan)).toBe(total);
    }
  });

  it('advances by 7950 ms, not 8000, which is what makes the length identity hold', () => {
    const plan = segmentPlan(20_000);

    expect(plan.segments.map((segment) => segment.startMs)).toEqual([0, 7_950, 15_900]);
    expect(plan.segments.map((segment) => segment.endMs)).toEqual([8_000, 15_950, 20_000]);
    expect(plan.segments.map((segment) => segment.durationMs)).toEqual([8_000, 8_000, 4_100]);
  });

  it('takes the smallest count that covers the clip', () => {
    // ceil((total − 50) / 7950).
    expect(segmentPlan(8_000).segments).toHaveLength(1);
    expect(segmentPlan(8_001).segments).toHaveLength(2);
    expect(segmentPlan(ADVANCE_MS + V2A_SEGMENT_MAX_MS).segments).toHaveLength(2);
    expect(segmentPlan(ADVANCE_MS + V2A_SEGMENT_MAX_MS + 1).segments).toHaveLength(3);
    expect(segmentPlan(60_000).segments).toHaveLength(8);
  });

  it('never exceeds the engine window and always overlaps by exactly 50 ms', () => {
    for (const total of [500, 8_000, 8_050, 16_000, 23_500, 40_000, 60_000]) {
      const plan = segmentPlan(total);

      expect(respectsSegmentCeiling(plan)).toBe(true);
      expect(hasStatedOverlaps(plan)).toBe(true);
      expect(plan.overlapMs).toBe(V2A_SEGMENT_OVERLAP_MS);
    }
  });

  it('leaves a tail longer than its own cross-fade', () => {
    // A naive ceil(total / 8000) split produces a 1 ms final segment for 24 001 ms; the
    // 7950 ms advance produces one of 400 ms.
    const plan = segmentPlan(24_001);

    expect(lastSegmentExceedsOverlap(plan)).toBe(true);
    expect(plan.segments.at(-1)?.durationMs).toBeGreaterThan(V2A_SEGMENT_OVERLAP_MS);
  });

  it('refuses a configuration whose overlap is not shorter than its segment', () => {
    expect(() => segmentPlan(20_000, { segmentMaxMs: 50, overlapMs: 50 })).toThrow(RangeError);
  });

  it('honours an injected window, so the arithmetic is not tied to 8000 and 50', () => {
    const plan = segmentPlan(2_500, { segmentMaxMs: 1_000, overlapMs: 100 });

    expect(plan.segments.map((segment) => segment.startMs)).toEqual([0, 900, 1_800]);
    expect(joinedDurationMs(plan)).toBeCloseTo(2_500, 9);
  });
});

describe('the join (Requirement 23.7)', () => {
  it('returns a single segment unchanged, sample for sample', () => {
    const only = monoAudio(sine(200, frames(1_000)));
    const joined = crossfadeJoin([only]);

    expect(joined.overlapFrames).toEqual([]);
    expect(joined.audio.channels[0]).toEqual(only.channels[0]);
  });

  it('consumes exactly one overlap per join, so length is the sum minus the overlaps', () => {
    const overlapFrames = frames(V2A_SEGMENT_OVERLAP_MS);
    const joined = crossfadeJoin([flat(8_000, 0.5), flat(8_000, 0.5), flat(4_100, 0.5)]);

    expect(joined.overlapFrames).toEqual([overlapFrames, overlapFrames]);
    expect(frameCount(joined.audio)).toBe(
      frames(8_000) * 2 + frames(4_100) - 2 * overlapFrames,
    );
    expect(joined.durationMs).toBeCloseTo(20_000, 6);
  });

  it('cross-fades with equal-gain weights, so a constant level survives the seam', () => {
    // Both segments hold the same constant, so 1−w + w = 1 must reproduce it exactly.
    const joined = crossfadeJoin([flat(1_000, 0.4), flat(1_000, 0.4)], V2A_SEGMENT_OVERLAP_MS);
    const channel = joined.audio.channels[0] ?? new Float32Array(0);
    // Asserted as the extremes rather than sample by sample: `expect` 96 000 times is a second
    // of test time for evidence the bounds give exactly as well.
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (const sample of channel) {
      if (sample < lowest) lowest = sample;
      if (sample > highest) highest = sample;
    }

    expect(lowest).toBeCloseTo(0.4, 6);
    expect(highest).toBeCloseTo(0.4, 6);
  });

  it('ramps symmetrically, so neither end of the fade steps', () => {
    const overlapFrames = frames(V2A_SEGMENT_OVERLAP_MS);
    // Outgoing 1.0, incoming 0.0: the fade region reads off the weights directly.
    const joined = crossfadeJoin([flat(1_000, 1), flat(1_000, 0)], V2A_SEGMENT_OVERLAP_MS);
    const channel = joined.audio.channels[0] ?? new Float32Array(0);
    const fadeStart = frames(1_000) - overlapFrames;

    // w = (k + ½)/o, so the outgoing weight runs from just under 1 to just over 0 —
    // symmetric about the middle, which is what keeps both seams continuous.
    expect(channel[fadeStart]).toBeCloseTo(1 - 0.5 / overlapFrames, 6);
    expect(channel[fadeStart + overlapFrames - 1]).toBeCloseTo(
      0.5 / overlapFrames,
      6,
    );
    const middle = channel[fadeStart + overlapFrames / 2] ?? 0;
    expect(middle).toBeCloseTo(0.5, 3);
  });

  it('clamps the overlap to the shorter neighbour rather than consuming a segment whole', () => {
    // A 20 ms segment cannot give up 50 ms of overlap.
    const joined = crossfadeJoin([flat(1_000, 0.5), flat(20, 0.5)], V2A_SEGMENT_OVERLAP_MS);

    expect(joined.overlapFrames).toEqual([frames(20)]);
    expect(frameCount(joined.audio)).toBe(frames(1_000));
  });

  it('preserves stereo channel count and joins each channel independently', () => {
    const stereo = (value: number, ms: number): PcmAudio => ({
      sampleRate: TEST_SAMPLE_RATE,
      channels: [
        new Float32Array(frames(ms)).fill(value),
        new Float32Array(frames(ms)).fill(-value),
      ],
    });
    const joined = crossfadeJoin([stereo(0.3, 500), stereo(0.3, 500)]);

    expect(joined.audio.channels).toHaveLength(2);
    expect(peakAbs(joined.audio.channels[0] ?? new Float32Array(0))).toBeCloseTo(0.3, 6);
    expect(peakAbs(joined.audio.channels[1] ?? new Float32Array(0))).toBeCloseTo(0.3, 6);
  });

  it('refuses segments of different shape rather than resampling or dropping a channel', () => {
    const at48 = monoAudio(new Float32Array(frames(100)).fill(0.2), 48_000);
    const at44 = monoAudio(new Float32Array(frames(100, 44_100)).fill(0.2), 44_100);

    expect(() => crossfadeJoin([at48, at44])).toThrow(SegmentJoinError);
    expect(() =>
      crossfadeJoin([at48, { sampleRate: 48_000, channels: [at48.channels[0] ?? new Float32Array(0), at48.channels[0] ?? new Float32Array(0)] }]),
    ).toThrow(SegmentJoinError);
  });

  it('refuses an empty segment list', () => {
    expect(() => crossfadeJoin([])).toThrow(SegmentJoinError);
  });
});

describe('the join reproduces the clip length (Requirements 23.7, 23.9)', () => {
  it('lands within a sample of the input for every plan of a 60 s clip', () => {
    for (const total of [500, 3_000, 8_000, 8_050, 12_345, 20_000, 47_500, 60_000]) {
      const plan = segmentPlan(total);
      const joined = crossfadeJoin(
        plan.segments.map((segment) => flat(segment.durationMs, 0.5)),
        plan.overlapMs,
      );

      // One sample at 48 kHz is 0.021 ms; Requirement 23.9's budget is 40 ms.
      expect(Math.abs(joined.durationMs - total)).toBeLessThan(1000 / TEST_SAMPLE_RATE);
      expect(Math.abs(durationMs(joined.audio) - total)).toBeLessThan(1000 / TEST_SAMPLE_RATE);
    }
  });
});
