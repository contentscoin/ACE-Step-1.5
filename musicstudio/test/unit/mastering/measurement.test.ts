import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { OCTAVE_BAND_CENTRES_HZ } from '../../../domain/mastering/bounds';
import {
  isWellFormedMeasurement,
  reportMeasurement,
  roundToStep,
} from '../../../domain/mastering/measurement';
import { measurement } from '../../support/mastering-harness';

/**
 * The loudness report of Requirements 30.22 and 30.24.
 *
 * **Validates: Requirements 30.22, 30.24**
 *
 * The rounding tests are the substantive ones, and they exist because the rule has two
 * traps. Half-up rounding biases negative numbers — and almost every number here is
 * negative — while the obvious `Math.round(x * 10) / 10` reports `-14.299999999999999` for a
 * value it is meant to quantise to one decimal.
 */

describe('rounding to the 0.1 step (Requirement 30.24)', () => {
  it('rounds to one decimal', () => {
    expect(roundToStep(-14.34)).toBe(-14.3);
    expect(roundToStep(-14.36)).toBe(-14.4);
    expect(roundToStep(-0.96)).toBe(-1.0);
  });

  it('rounds halves away from zero, symmetrically', () => {
    // Not half-up: loudness and true-peak values are almost always negative, so half-up
    // would systematically report audio as louder than it is at exactly the tie.
    expect(roundToStep(-14.05)).toBe(-14.1);
    expect(roundToStep(14.05)).toBe(14.1);
    expect(roundToStep(-14.15)).toBe(-14.2);
    expect(roundToStep(14.15)).toBe(14.2);
  });

  it('does not leak float error into the reported value', () => {
    // `143 * 0.1` is 14.299999999999999, which would contradict "0.1 단위로 반올림".
    expect(roundToStep(-14.29)).toBe(-14.3);
    expect(String(roundToStep(-14.29))).toBe('-14.3');
    expect(String(roundToStep(-0.75))).toBe('-0.8');
  });

  it('leaves infinities and NaN alone', () => {
    expect(roundToStep(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(roundToStep(Number.NaN))).toBe(true);
  });

  it('always lands on a tenth, for any finite input', () => {
    // An unnumbered property test. Design §10 numbers Properties 1–24; this is not one of
    // them and is labelled so task 9.2's audit does not miscount it.
    fc.assert(
      fc.property(
        fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const rounded = roundToStep(value);
          return Math.abs(rounded * 10 - Math.round(rounded * 10)) < 1e-9;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never moves a value by more than half a step', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
        (value) => Math.abs(roundToStep(value) - value) <= 0.05 + 1e-9,
      ),
      { numRuns: 300 },
    );
  });
});

describe('the reported form (Requirement 30.24)', () => {
  it('quantises both headline numbers', () => {
    const reported = reportMeasurement(
      measurement({ integratedLoudnessLufs: -14.037, truePeakDbtp: -1.049 }),
    );

    expect(reported.integratedLoudnessLufs).toBe(-14.0);
    expect(reported.truePeakDbtp).toBe(-1.0);
  });

  it('leaves the band energies unrounded', () => {
    // 30.24's rounding rule names "두 측정값"; 30.22 asks for the band energies as values
    // without stating a precision.
    const source = measurement();

    expect(reportMeasurement(source).octaveBands).toBe(source.octaveBands);
  });

  it('is idempotent, so reporting a reported measurement changes nothing', () => {
    const once = reportMeasurement(measurement({ integratedLoudnessLufs: -14.037 }));

    expect(reportMeasurement(once)).toEqual(once);
  });
});

describe('shape (Requirement 30.22)', () => {
  it('accepts a report with the ten bands in the published order', () => {
    expect(isWellFormedMeasurement(measurement())).toBe(true);
  });

  it('refuses a report with the wrong number of bands', () => {
    // The measurement crosses a process boundary, so a worker returning nine bands would
    // otherwise produce a response the user reads positionally and misinterprets.
    expect(
      isWellFormedMeasurement(
        measurement({ octaveBands: measurement().octaveBands.slice(0, 9) }),
      ),
    ).toBe(false);
  });

  it('refuses a report whose bands are out of order', () => {
    expect(
      isWellFormedMeasurement(
        measurement({ octaveBands: [...measurement().octaveBands].reverse() }),
      ),
    ).toBe(false);
  });

  it('names the ten centres Requirement 30.22 lists', () => {
    expect([...OCTAVE_BAND_CENTRES_HZ]).toEqual([
      31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
    ]);
  });
});
