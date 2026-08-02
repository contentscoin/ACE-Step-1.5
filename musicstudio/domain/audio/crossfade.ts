/**
 * The one cross-fade join in the system (Requirements 23.7, 25.11, 25.15).
 *
 * Three criteria ask for the same 50 ms equal-gain cross-fade over adjacent audio
 * pieces, and the appendix table lists them together under a single entry ("조각 연결
 * 교차 페이드 | 50ms | 23.7, 25.11, 25.15"). So there is one implementation, here, and
 * `domain/v2a/segmentation.ts` re-exports it rather than owning it — task 2.6 wrote it
 * for video segments and task 2.7 extracted it unchanged for script chunks and line
 * re-synthesis. **A second cross-fade would be a second answer to a settled question**,
 * and the two would drift the moment one of the three criteria was revisited.
 *
 * ### The fade
 *
 * Linear equal-gain across the overlap: at position `k` of an `o`-frame overlap the
 * outgoing piece is weighted `1 − w` and the incoming one `w`, with `w = (k + ½) / o`.
 * The half-frame offset makes the ramp symmetric, so neither the seam into the fade nor
 * the seam out of it steps — an asymmetric ramp leaves a discontinuity at one end, and a
 * discontinuity is audible as the click these criteria exist to avoid.
 *
 * ### What the join guarantees about length
 *
 * The joined length is the sum of the pieces minus one overlap per join, and the overlaps
 * actually consumed are reported. That is what lets Requirement 23.9's ±40 ms and
 * Requirement 25.16's total-length arithmetic both be checked against a *stated* number
 * rather than against an assumption.
 *
 * Pure and deterministic: no clock, no engine, no allocation that depends on anything but
 * the inputs. Requirement 25.18's reproducibility extends through the join because the
 * join is a function.
 */

import { frameCount, windowSampleCount, type PcmAudio } from './pcm';

/**
 * The cross-fade length the three criteria quote, milliseconds.
 *
 * A constant rather than a Quality_Threshold_Set member: it is not a judgement about
 * whether audio is good enough, it is the shape of the splice, and Requirements 23.7,
 * 25.11 and 25.15 all state the same 50 ms. Changing it would change what every stored
 * asset's boundaries *are*, not merely which assets are admissible — the distinction
 * `domain/v2a/bounds.ts` draws.
 */
export const CROSSFADE_OVERLAP_MS = 50;

export class SegmentJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentJoinError';
  }
}

export interface JoinedSegments {
  readonly audio: PcmAudio;
  /** Frames of overlap actually consumed at each join, in order. */
  readonly overlapFrames: readonly number[];
  readonly durationMs: number;
}

/**
 * Requirements 23.7, 25.11, 25.15 — join adjacent pieces with a cross-fade.
 *
 * Every piece must share a sample rate and channel count; a mismatch is a programming
 * error rather than a recoverable condition, because it means two engine calls in one job
 * produced incompatible audio and joining them would silently resample or drop a channel.
 *
 * The overlap is clamped per join to the shorter of the two pieces involved. Clamping
 * rather than throwing because a clamped overlap still produces continuous audio of a
 * *stated* length — the effective overlaps are reported, so a caller can check the joined
 * length against its own requirement instead of against an assumption. Requirement 25.14
 * permits a one-character line, whose audio can easily be shorter than 50 ms.
 */
export function crossfadeJoin(
  segments: readonly PcmAudio[],
  overlapMs: number = CROSSFADE_OVERLAP_MS,
): JoinedSegments {
  if (segments.length === 0) {
    throw new SegmentJoinError('a cross-fade join needs at least one segment; received none');
  }

  const first = segments[0];
  if (first === undefined) {
    throw new SegmentJoinError('a cross-fade join needs at least one segment; received none');
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
