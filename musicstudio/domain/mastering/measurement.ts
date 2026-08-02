/**
 * The loudness report of Requirements 30.22 and 30.24.
 *
 * Three quantities: the BS.1770-4 integrated loudness, the 4×-oversampled true peak, and
 * the mean energy in each of ten octave bands. All three are *measured* in the DSP worker
 * (`dsp/src/musicstudio_dsp/loudness.py`) and reach the product layer through
 * `services/mastering/ports.ts`; this module is the shape they arrive in and the reporting
 * rule Requirement 30.24 imposes on top.
 *
 * ### Why the rounding is a separate step from the measurement
 *
 * Requirement 30.24 requires the two headline numbers to be "0.1 단위로 반올림하여 보고",
 * and that has to be a *presentation* step rather than something the measurement does.
 * Requirement 30.6's ±0.5 LUFS band and Requirement 30.8's ≤0.1 dB idempotence bound are
 * both checked against the unrounded values, and a bound of 0.1 compared against numbers
 * already quantised to 0.1 would be decided entirely by which side of a tie the rounding
 * fell on. So the port returns full precision, the service judges on that, and
 * `reportMeasurement` produces what the user sees.
 *
 * Rounding is half-away-from-zero rather than `Math.round`'s half-up, so that −14.05 and
 * +14.05 round to −14.1 and +14.1 rather than to −14.0 and +14.1. Loudness values are
 * negative and true peaks nearly always are, so half-up would systematically bias every
 * reported number towards zero — i.e. report audio as louder than it is at exactly the
 * tie. The scaled-integer form also avoids `Math.round(x * 10) / 10` reporting
 * `-14.299999999999999`.
 *
 * ### Silence
 *
 * `-Infinity` survives rounding unchanged, matching `integratedLoudnessLufs`'s treatment
 * in `domain/audio/loudness.ts`: a floor value would make a silent asset look like a
 * quiet one, and Requirement 30.6 gates on there being at least one block above −70 LUFS
 * precisely so that silence is *not* normalised.
 */

import {
  MEASUREMENT_REPORT_STEP,
  OCTAVE_BAND_CENTRES_HZ,
  OCTAVE_BAND_COUNT,
} from './bounds';

/** One octave band's mean energy (Requirement 30.22). */
export interface OctaveBandEnergy {
  readonly centreHz: number;
  /**
   * Mean energy in the band, in dB relative to full scale.
   *
   * dB rather than a linear mean square, because the clause calls for a "대역별 평균 에너지
   * 값" that a user compares against the loudness and true peak reported beside it, and
   * those are logarithmic. A linear value would put the ten bands on a different scale
   * from the two numbers they sit next to.
   */
  readonly energyDb: number;
}

export interface MasteringMeasurement {
  /** Requirement 30.24: BS.1770-4 gated integrated loudness, unrounded. */
  readonly integratedLoudnessLufs: number;
  /** Requirement 30.24: 4×-oversampled true peak in dBTP, unrounded. */
  readonly truePeakDbtp: number;
  /** Requirement 30.22: exactly ten bands, in `OCTAVE_BAND_CENTRES_HZ` order. */
  readonly octaveBands: readonly OctaveBandEnergy[];
}

/** Half-away-from-zero rounding to a step. See the module comment. */
export function roundToStep(value: number, step: number = MEASUREMENT_REPORT_STEP): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value / step;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  // Re-round the product to kill the float error the division/multiplication introduces:
  // 143 * 0.1 is 14.299999999999999, and reporting that would contradict "0.1 단위".
  return Number((rounded * step).toFixed(10));
}

/** Requirement 30.24's reported form: both headline numbers quantised to 0.1. */
export function reportMeasurement(measurement: MasteringMeasurement): MasteringMeasurement {
  return {
    integratedLoudnessLufs: roundToStep(measurement.integratedLoudnessLufs),
    truePeakDbtp: roundToStep(measurement.truePeakDbtp),
    // Left unrounded: 30.24's rounding rule names "두 측정값" — the loudness and the true
    // peak — and says nothing about the band energies, which 30.22 asks for as values
    // rather than to any stated precision.
    octaveBands: measurement.octaveBands,
  };
}

/**
 * Whether a measurement has the shape Requirement 30.22 requires.
 *
 * Checked rather than trusted because the measurement crosses a process boundary: the ten
 * bands arrive from the DSP worker, and a worker returning nine — or ten in a different
 * order — would produce a response the user reads positionally and misinterprets silently.
 */
export function isWellFormedMeasurement(measurement: MasteringMeasurement): boolean {
  if (measurement.octaveBands.length !== OCTAVE_BAND_COUNT) return false;
  return measurement.octaveBands.every(
    (band, index) => band.centreHz === OCTAVE_BAND_CENTRES_HZ[index],
  );
}
