/**
 * The ITU-R BS.1770-4 K-weighting filter (design §5.1).
 *
 * Two cascaded second-order sections: a high-frequency shelving filter that models
 * the acoustic effect of a head, followed by a high-pass ("RLB") that discounts very
 * low frequencies. BS.1770 tabulates the coefficients at 48 kHz only, so they are
 * *derived* here from the analog prototype parameters rather than transcribed, which
 * is what makes a 44.1 kHz or 96 kHz asset measurable with the same code. At 48 kHz
 * the derivation reproduces the tabulated coefficients, and
 * `test/unit/bgm/loudness.test.ts` pins that against the published table.
 *
 * Pure and allocation-light: one `Float32Array` out per channel in, no state kept
 * between calls, so two measurements of the same buffer agree exactly. That
 * determinism is what lets Requirement 21.11's loudness ladder be an invariant rather
 * than a tolerance band around a stochastic measurement.
 */

/** Coefficients of `y[n] = b0·x[n] + b1·x[n-1] + b2·x[n-2] - a1·y[n-1] - a2·y[n-2]`. */
export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * Analog prototype of the shelving stage, from BS.1770-4's filter description.
 *
 * The gain, Q and centre frequency are the values that reproduce the standard's
 * 48 kHz coefficient table under the bilinear transform below.
 */
const SHELF_GAIN_DB = 3.999_843_853_973_347;
const SHELF_Q = 0.707_175_236_955_419_6;
const SHELF_FC_HZ = 1_681.974_450_955_533;
/** Exponent relating the shelf's band gain to its high-frequency gain. */
const SHELF_BAND_GAIN_EXPONENT = 0.499_666_774_154_641_6;

/** Analog prototype of the RLB high-pass stage. */
const HIGHPASS_Q = 0.500_327_037_323_877_3;
const HIGHPASS_FC_HZ = 38.135_470_876_024_44;

export function highShelfStage(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * SHELF_FC_HZ) / sampleRate);
  const vh = 10 ** (SHELF_GAIN_DB / 20);
  const vb = vh ** SHELF_BAND_GAIN_EXPONENT;
  const kSquared = k * k;
  const denominator = 1 + k / SHELF_Q + kSquared;

  return {
    b0: (vh + (vb * k) / SHELF_Q + kSquared) / denominator,
    b1: (2 * (kSquared - vh)) / denominator,
    b2: (vh - (vb * k) / SHELF_Q + kSquared) / denominator,
    a1: (2 * (kSquared - 1)) / denominator,
    a2: (1 - k / SHELF_Q + kSquared) / denominator,
  };
}

export function highPassStage(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * HIGHPASS_FC_HZ) / sampleRate);
  const kSquared = k * k;
  const denominator = 1 + k / HIGHPASS_Q + kSquared;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (kSquared - 1)) / denominator,
    a2: (1 - k / HIGHPASS_Q + kSquared) / denominator,
  };
}

export function kWeightingStages(sampleRate: number): readonly Biquad[] {
  return [highShelfStage(sampleRate), highPassStage(sampleRate)];
}

/** Direct-form-I biquad, from rest. */
export function applyBiquad(stage: Biquad, samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index] ?? 0;
    const y0 =
      stage.b0 * x0 + stage.b1 * x1 + stage.b2 * x2 - stage.a1 * y1 - stage.a2 * y2;
    out[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return out;
}

export function applyKWeighting(samples: Float32Array, sampleRate: number): Float32Array {
  let signal = samples;
  for (const stage of kWeightingStages(sampleRate)) {
    signal = applyBiquad(stage, signal);
  }
  return signal;
}

/**
 * `|H(f)|` of the whole K-weighting cascade, evaluated on the unit circle.
 *
 * Used only by tests, and deliberately so: it is an *independent* route to the same
 * filter — frequency-domain evaluation of the transfer function versus time-domain
 * recursion — which is what lets the loudness of a synthesised sine be predicted and
 * compared rather than merely re-measured by the code under test.
 */
export function kWeightingMagnitudeAt(frequencyHz: number, sampleRate: number): number {
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  const cos1 = Math.cos(omega);
  const sin1 = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);

  let magnitude = 1;
  for (const stage of kWeightingStages(sampleRate)) {
    const numeratorReal = stage.b0 + stage.b1 * cos1 + stage.b2 * cos2;
    const numeratorImaginary = -(stage.b1 * sin1 + stage.b2 * sin2);
    const denominatorReal = 1 + stage.a1 * cos1 + stage.a2 * cos2;
    const denominatorImaginary = -(stage.a1 * sin1 + stage.a2 * sin2);

    magnitude *=
      Math.hypot(numeratorReal, numeratorImaginary) /
      Math.hypot(denominatorReal, denominatorImaginary);
  }
  return magnitude;
}
