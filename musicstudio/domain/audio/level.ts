/**
 * Amplitude measurements: RMS over a window, peak, and the dB comparisons the loop
 * criteria are stated in.
 *
 * Everything returns a **linear amplitude**, and the conversion to dB happens only
 * where a requirement is written in dB. That ordering matters: a silent window has
 * an RMS of 0, whose dB value is `-Infinity`, and `-Infinity - (-Infinity)` is `NaN`.
 * Requirement 21.7 compares two windows of a loop that may legitimately both be
 * silent, so the comparison is defined here on amplitudes — where "both zero" has the
 * obvious answer of "no difference" — instead of being left to produce a `NaN` that
 * would silently fail every comparison it touched.
 */

/** Root mean square of `count` samples starting at `start`. */
export function rms(samples: Float32Array, start: number, count: number): number {
  const from = Math.max(0, Math.min(start, samples.length));
  const to = Math.max(from, Math.min(start + count, samples.length));
  if (to === from) return 0;

  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (to - from));
}

export function rmsOf(samples: Float32Array): number {
  return rms(samples, 0, samples.length);
}

/** Largest absolute sample value — Requirement 21.8's "최대 절대 진폭". */
export function peakAbs(samples: Float32Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index] ?? 0);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/** Amplitude ratio in dB. `-Infinity` for silence, by definition. */
export function amplitudeToDb(amplitude: number): number {
  if (amplitude <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(amplitude);
}

export function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}

/**
 * `|20·log10(a) − 20·log10(b)|` — how far apart two amplitudes are, regardless of order.
 *
 * Requirement 21.7 bounds "차이" between the tail and head RMS without saying which
 * is larger, so the magnitude is the quantity under test. Two silent windows differ
 * by 0 dB; one silent window differs from a non-silent one by an unbounded amount,
 * reported as `Infinity` so the comparison against any finite ceiling fails rather
 * than accidentally passing.
 *
 * Stated as a *difference of logs* rather than the algebraically equal `log10(a / b)`,
 * because the ratio can overflow to `Infinity` for two finite positive amplitudes far
 * enough apart while the subtraction cannot. That made the older form asymmetric —
 * `f(a, b) ≠ f(b, a)` — since only one of the two divisions overflowed. A property test
 * over arbitrary amplitude pairs found it, and symmetry is not optional here: nothing
 * about Requirement 21.7 privileges the tail over the head.
 */
export function amplitudeDifferenceDb(first: number, second: number): number {
  if (first === second) return 0;
  if (first <= 0 || second <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(amplitudeToDb(first) - amplitudeToDb(second));
}
