/**
 * Splitting a clip into engine-sized segments and joining what comes back
 * (Requirements 23.7, 23.9).
 *
 * 23.7: "영상을 인접 구간이 50밀리초씩 겹치는 8초 이하 구간으로 분할하여 순차 생성하고, 인접
 * 구간의 산출 오디오를 그 50밀리초 겹침 구간에서 교차 페이드로 연결하여 합산 길이가 입력 영상
 * 길이와 같아지도록 한다".
 *
 * Three claims in one sentence, and the arithmetic has to make all three true at once:
 * every segment is at most 8 s, adjacent segments overlap by exactly 50 ms, and the joined
 * length equals the input length. They are not independent — the third is a *consequence*
 * of the first two only if the segments advance by `8000 − 50` ms rather than by 8000, and
 * if the join consumes each overlap exactly once.
 *
 * ### The plan
 *
 * Segment `i` starts at `i × 7950` ms and ends 8000 ms later, or at the end of the clip,
 * whichever is sooner. The count is `ceil((total − 50) / 7950)`, which is the smallest `n`
 * with `(n−1) × 7950 + 8000 ≥ total`.
 *
 * The joined length then telescopes:
 * `Σ len − (n−1) × 50 = 8000(n−1) + (total − 7950(n−1)) − 50(n−1) = total`.
 * `segmentPlan` asserts that identity on the plan it returns rather than trusting it, so a
 * future change to either constant fails loudly instead of drifting the output length past
 * Requirement 23.9's ±40 ms.
 *
 * One consequence worth stating because it is easy to get wrong: **the last segment is
 * always strictly longer than the overlap.** From `n = ceil((total − 50) / 7950)` we get
 * `(n−1) × 7950 < total − 50`, so the final segment spans more than 50 ms. A shorter tail
 * would be entirely consumed by its own cross-fade, which is how a naive `ceil(total /
 * 8000)` split produces a clip that ends mid-fade.
 *
 * ### The join
 *
 * Linear equal-gain cross-fade across the overlap: at position `k` of an `o`-frame overlap
 * the outgoing segment is weighted `1 − w` and the incoming one `w`, with
 * `w = (k + ½) / o`. The half-frame offset makes the ramp symmetric, so neither the seam
 * into the fade nor the seam out of it steps — an asymmetric ramp leaves a discontinuity at
 * one end, and a discontinuity is audible as the click 23.7 exists to avoid.
 *
 * Pure and deterministic: no clock, no engine, no allocation that depends on anything but
 * the inputs. Requirement 23.14's reproducibility extends through the join because the
 * join is a function.
 */

import { frameCount, windowSampleCount, type PcmAudio } from '../audio/pcm';

import { V2A_SEGMENT_MAX_MS, V2A_SEGMENT_OVERLAP_MS } from './bounds';

export interface VideoSegment {
  /** 0-based position in the sequential generation order of 23.7. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

export interface SegmentPlan {
  readonly segments: readonly VideoSegment[];
  readonly overlapMs: number;
  readonly segmentMaxMs: number;
  /** The clip length the plan covers, echoed so a verdict can cite it. */
  readonly totalDurationMs: number;
}

export interface SegmentPlanOptions {
  /** Requirement 23.7's 8 s. Injectable so a test can shrink it and still be honest. */
  readonly segmentMaxMs?: number;
  /** Requirement 23.7's 50 ms. */
  readonly overlapMs?: number;
}

/**
 * Requirement 23.7's split.
 *
 * A clip no longer than one segment yields exactly one segment covering all of it, with no
 * overlap to consume — which is the common case, since Requirement 23.3 permits clips as
 * short as 500 ms.
 */
export function segmentPlan(
  totalDurationMs: number,
  options: SegmentPlanOptions = {},
): SegmentPlan {
  const segmentMaxMs = options.segmentMaxMs ?? V2A_SEGMENT_MAX_MS;
  const overlapMs = options.overlapMs ?? V2A_SEGMENT_OVERLAP_MS;
  const advanceMs = segmentMaxMs - overlapMs;

  if (!(advanceMs > 0)) {
    throw new RangeError(
      `Requirement 23.7 needs a segment longer than its overlap; received ` +
        `${String(segmentMaxMs)} ms and ${String(overlapMs)} ms`,
    );
  }

  const total = Math.max(0, totalDurationMs);
  const count = Math.max(1, Math.ceil((total - overlapMs) / advanceMs));
  const segments: VideoSegment[] = [];

  for (let index = 0; index < count; index += 1) {
    const startMs = index * advanceMs;
    const endMs = Math.min(startMs + segmentMaxMs, total);
    segments.push({ index, startMs, endMs, durationMs: Math.max(0, endMs - startMs) });
  }

  const plan: SegmentPlan = { segments, overlapMs, segmentMaxMs, totalDurationMs: total };

  // The identity the module comment derives. A programming error if it fails, not a user
  // input problem — which is why it throws rather than returning a verdict.
  const joined = joinedDurationMs(plan);
  if (Math.abs(joined - total) > 1e-6) {
    throw new RangeError(
      `Requirement 23.7 segmentation lost length: ${String(joined)} ms joined from a ` +
        `${String(total)} ms clip`,
    );
  }

  return plan;
}

/** Requirement 23.7: what the joined audio should measure, from the plan alone. */
export function joinedDurationMs(plan: SegmentPlan): number {
  const summed = plan.segments.reduce((total, segment) => total + segment.durationMs, 0);
  return summed - Math.max(0, plan.segments.length - 1) * plan.overlapMs;
}

/** Requirement 23.7: no segment exceeds the engine's window. */
export function respectsSegmentCeiling(plan: SegmentPlan): boolean {
  return plan.segments.every((segment) => segment.durationMs <= plan.segmentMaxMs + 1e-9);
}

/**
 * Requirement 23.7: adjacent segments overlap by exactly the stated amount.
 *
 * Checked as `start[i+1] + overlap === end[i]` rather than by measuring the intersection,
 * because that is the form the requirement states and the form the join relies on.
 */
export function hasStatedOverlaps(plan: SegmentPlan): boolean {
  for (let index = 1; index < plan.segments.length; index += 1) {
    const previous = plan.segments[index - 1];
    const current = plan.segments[index];
    if (previous === undefined || current === undefined) return false;
    if (Math.abs(previous.endMs - current.startMs - plan.overlapMs) > 1e-6) return false;
  }
  return true;
}

/** Requirement 23.7: the tail is longer than its own cross-fade. See the module comment. */
export function lastSegmentExceedsOverlap(plan: SegmentPlan): boolean {
  const last = plan.segments[plan.segments.length - 1];
  if (last === undefined) return false;
  if (plan.segments.length === 1) return true;
  return last.durationMs > plan.overlapMs;
}

export class SegmentJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentJoinError';
  }
}

/**
 * Requirement 23.7's cross-fade join.
 *
 * Every segment must share a sample rate and channel count; a mismatch is a programming
 * error rather than a recoverable condition, because it means two engine calls in one job
 * produced incompatible audio and joining them would silently resample or drop a channel.
 *
 * The overlap is clamped per join to the shorter of the two segments involved. Clamping
 * rather than throwing because a clamped overlap still produces continuous audio of a
 * *stated* length — `crossfadeJoin` reports the effective overlaps it used, so a caller can
 * check the joined length against Requirement 23.9 instead of against an assumption.
 */
export interface JoinedSegments {
  readonly audio: PcmAudio;
  /** Frames of overlap actually consumed at each join, in order. */
  readonly overlapFrames: readonly number[];
  readonly durationMs: number;
}

export function crossfadeJoin(
  segments: readonly PcmAudio[],
  overlapMs: number = V2A_SEGMENT_OVERLAP_MS,
): JoinedSegments {
  if (segments.length === 0) {
    throw new SegmentJoinError('Requirement 23.7 joins at least one segment; received none');
  }

  const first = segments[0];
  if (first === undefined) {
    throw new SegmentJoinError('Requirement 23.7 joins at least one segment; received none');
  }

  const sampleRate = first.sampleRate;
  const channels = first.channels.length;
  for (const segment of segments) {
    if (segment.sampleRate !== sampleRate || segment.channels.length !== channels) {
      throw new SegmentJoinError(
        `segments differ in shape: ${String(sampleRate)} Hz/${String(channels)} ch vs ` +
          `${String(segment.sampleRate)} Hz/${String(segment.channels.length)} ch`,
      );
    }
  }

  const lengths = segments.map((segment) => frameCount(segment));
  const nominalOverlap = windowSampleCount(sampleRate, overlapMs);

  // Per-join effective overlap: never longer than either neighbour, so no join can consume
  // a segment whole and no offset can run backwards.
  const overlapFrames: number[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    overlapFrames.push(
      Math.max(0, Math.min(nominalOverlap, lengths[index] ?? 0, lengths[index - 1] ?? 0)),
    );
  }

  const totalFrames =
    lengths.reduce((sum, length) => sum + length, 0) -
    overlapFrames.reduce((sum, frames) => sum + frames, 0);

  const output = Array.from({ length: channels }, () => new Float32Array(Math.max(0, totalFrames)));

  // `cursor` is one past the last frame written. Each new segment starts `overlap` frames
  // *before* it, which is what makes the fade region land on audio that is already there —
  // and what makes the joined length shorter than the sum by exactly one overlap per join.
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const overlap = index === 0 ? 0 : (overlapFrames[index - 1] ?? 0);
    const offset = index === 0 ? 0 : cursor - overlap;

    for (let channel = 0; channel < channels; channel += 1) {
      const source = segment.channels[channel] ?? new Float32Array(0);
      const target = output[channel];
      if (target === undefined) continue;

      // The cross-fade region: what is already written fades out as the new segment fades
      // in, both linearly, weights summing to 1 at every frame.
      for (let k = 0; k < overlap; k += 1) {
        const position = offset + k;
        if (position >= target.length) break;
        const weight = (k + 0.5) / overlap;
        target[position] = (target[position] ?? 0) * (1 - weight) + (source[k] ?? 0) * weight;
      }

      // The rest of the segment is copied as-is.
      for (let k = overlap; k < source.length; k += 1) {
        const position = offset + k;
        if (position >= target.length) break;
        target[position] = source[k] ?? 0;
      }
    }

    cursor = offset + (lengths[index] ?? 0);
  }

  return {
    audio: { sampleRate, channels: output },
    overlapFrames,
    durationMs: sampleRate > 0 ? (Math.max(0, totalFrames) * 1000) / sampleRate : 0,
  };
}
