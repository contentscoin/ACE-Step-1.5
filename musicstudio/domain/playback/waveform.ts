/**
 * Waveform data (Requirement 12.7), and where its numbers come from.
 *
 * Requirement 12.7 says "파형 데이터를 반환한다" and fixes nothing else, so the shape is a
 * product decision, recorded here:
 *
 * - **Peaks, not samples.** A five-minute asset is 14.4 million frames; a client draws a few
 *   hundred pixels. What a drawing needs is the extreme of each bucket, and sending frames
 *   would move megabytes to render kilobytes.
 * - **Both extremes per bucket.** A waveform drawn from `max(abs)` alone is symmetric and
 *   loses the asymmetry real audio has. Two numbers per bucket cost nothing next to the
 *   saving above.
 * - **Normalised to [-1, 1].** The same range the samples are in (design §5.1), so a client
 *   scales by its own height and nothing has to know the bit depth.
 *
 * The reduction itself runs in the DSP worker (`dsp/src/musicstudio_dsp/waveform.py`); this
 * module is the bucket arithmetic both sides agree on, so a cached waveform computed at one
 * bucket count can be checked against a request for another.
 */

export const WAVEFORM_BUCKETS_MIN = 16;
export const WAVEFORM_BUCKETS_MAX = 4_000;
export const WAVEFORM_BUCKETS_DEFAULT = 800;

export interface WaveformBucket {
  /** Most negative sample in the bucket, in [-1, 0]. */
  readonly min: number;
  /** Most positive sample in the bucket, in [0, 1]. */
  readonly max: number;
}

export interface Waveform {
  readonly assetId: string;
  readonly buckets: readonly WaveformBucket[];
  /** What the buckets span, so a client can map a bucket to a time. */
  readonly durationMs: number;
  readonly channels: number;
}

export function isWaveformBucketCount(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= WAVEFORM_BUCKETS_MIN &&
    value <= WAVEFORM_BUCKETS_MAX
  );
}

/**
 * How many frames fall in each bucket, and where each begins.
 *
 * Frames rarely divide evenly into buckets, and the remainder has to go somewhere. It is
 * spread — the first `frames % buckets` buckets take one extra — rather than piled onto the
 * last one, which would make the final bucket of a long asset visibly taller than its
 * neighbours for a reason that is arithmetic rather than audio.
 */
export function bucketBoundaries(frameCount: number, buckets: number): readonly number[] {
  if (frameCount <= 0 || buckets <= 0) return [];

  const base = Math.floor(frameCount / buckets);
  const remainder = frameCount % buckets;
  const boundaries: number[] = [];

  let cursor = 0;
  for (let index = 0; index < buckets; index += 1) {
    boundaries.push(cursor);
    cursor += base + (index < remainder ? 1 : 0);
  }
  boundaries.push(frameCount);
  return boundaries;
}

/**
 * The time a bucket starts at, for Requirement 12.5's synchronisation and for a client
 * mapping a click on the waveform back to a position.
 */
export function bucketStartMs(index: number, buckets: number, durationMs: number): number {
  if (buckets <= 0) return 0;
  return (Math.max(0, Math.min(index, buckets)) * durationMs) / buckets;
}

/** Fewer buckets than frames, always: a bucket per frame is the sample dump 12.7 is not. */
export function resolveBucketCount(requested: number | undefined, frameCount: number): number {
  const wanted = isWaveformBucketCount(requested) ? (requested as number) : WAVEFORM_BUCKETS_DEFAULT;
  return Math.max(1, Math.min(wanted, frameCount));
}
