import { describe, expect, it } from 'vitest';

import {
  applyKWeighting,
  highPassStage,
  highShelfStage,
  kWeightingMagnitudeAt,
} from '../../../domain/audio/k-weighting';
import { peakAbs, rmsOf } from '../../../domain/audio/level';
import {
  CHANNEL_WEIGHT_G,
  LOUDNESS_ABSOLUTE_GATE_LUFS,
  integratedLoudnessLufs,
} from '../../../domain/audio/loudness';
import {
  TEST_SAMPLE_RATE,
  alternating,
  duplicatedToStereo,
  frames,
  monoAudio,
  scaled,
  sine,
} from '../../support/pcm-synthesis';

/**
 * The DSP behind Requirements 21.11 and 21.15: ITU-R BS.1770-4 integrated loudness.
 *
 * **Validates: Requirements 21.11, 21.15**
 *
 * The measurement is genuinely computed, so it is genuinely checkable. Three independent
 * routes are used, and none of them is "run the code and record what it said":
 *
 * 1. The K-weighting coefficients are compared against BS.1770-4's **published 48 kHz
 *    table**. The implementation derives them from the analog prototype so that other
 *    sample rates work; at 48 kHz the derivation must reproduce the standard.
 * 2. The filter's time-domain recursion is compared against a frequency-domain
 *    evaluation of its own transfer function — two different computations of the same
 *    filter, which agree only if both are right.
 * 3. Loudness is checked through its *scaling relation*: multiplying a buffer by `g`
 *    must move its loudness by exactly `20·log10(g)`. This is the property Requirement
 *    21.11's ladder rests on, and it holds for a linear filter with scale-relative gates
 *    regardless of the absolute calibration.
 */

/**
 * BS.1770-4 Tables 1 and 2 — the coefficients the standard tabulates at 48 kHz.
 *
 * Transcribed from the standard's own tables. The standard writes its recursion as
 * `y[n] = Σ b_i·x[n-i] − Σ a_i·y[n-i]`, which is the convention `applyBiquad` uses, so
 * these are compared directly rather than negated.
 */
const PUBLISHED_48K_SHELF = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};

const PUBLISHED_48K_HIGHPASS = {
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

describe('K-weighting coefficients (design §5.1)', () => {
  it('reproduces the published 48 kHz shelving filter table', () => {
    const stage = highShelfStage(48_000);

    expect(stage.b0).toBeCloseTo(PUBLISHED_48K_SHELF.b0, 6);
    expect(stage.b1).toBeCloseTo(PUBLISHED_48K_SHELF.b1, 6);
    expect(stage.b2).toBeCloseTo(PUBLISHED_48K_SHELF.b2, 6);
    expect(stage.a1).toBeCloseTo(PUBLISHED_48K_SHELF.a1, 6);
    expect(stage.a2).toBeCloseTo(PUBLISHED_48K_SHELF.a2, 6);
  });

  it('reproduces the published 48 kHz high-pass table', () => {
    const stage = highPassStage(48_000);

    expect(stage.b0).toBe(1);
    expect(stage.b1).toBe(-2);
    expect(stage.b2).toBe(1);
    expect(stage.a1).toBeCloseTo(PUBLISHED_48K_HIGHPASS.a1, 6);
    expect(stage.a2).toBeCloseTo(PUBLISHED_48K_HIGHPASS.a2, 6);
  });

  it('derives coefficients for a rate the standard does not tabulate', () => {
    // Requirement 21.7 measures "저장된 샘플레이트에서", so a 44.1 kHz asset must be
    // measurable. A stable filter has both poles inside the unit circle, i.e. |a2| < 1.
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      expect(Math.abs(highShelfStage(sampleRate).a2)).toBeLessThan(1);
      expect(Math.abs(highPassStage(sampleRate).a2)).toBeLessThan(1);
    }
  });
});

describe('K-weighting response (design §5.1)', () => {
  it('matches the frequency-domain magnitude of its own transfer function', () => {
    // Two independent computations of one filter: time-domain recursion over a steady
    // sine versus |H(f)| on the unit circle. The steady-state amplitude ratio of the
    // former must equal the latter.
    for (const frequencyHz of [200, 1_000, 4_000]) {
      const input = sine(frequencyHz, frames(1_000), 0.5);
      const output = applyKWeighting(input, TEST_SAMPLE_RATE);
      // Skip the first 100 ms so the filter's transient has decayed.
      const settled = output.slice(frames(100));
      const measuredGain = rmsOf(settled) / rmsOf(input.slice(frames(100)));

      expect(measuredGain).toBeCloseTo(kWeightingMagnitudeAt(frequencyHz, TEST_SAMPLE_RATE), 2);
    }
  });

  it('traces the published K-weighting curve at its named anchor frequencies', () => {
    // The four points that characterise the curve, each to 0.1 dB: the RLB roll-off
    // low down, the ~0 dB crossing in the low midrange, and the head shelf's +4 dB
    // plateau up top. Note it is *not* unity at 1 kHz — the +0.70 dB there is exactly
    // what makes a full-scale 1 kHz sine read −3.01 LUFS below.
    const responseDb = (frequencyHz: number): number =>
      20 * Math.log10(kWeightingMagnitudeAt(frequencyHz, TEST_SAMPLE_RATE));

    expect(responseDb(20)).toBeCloseTo(-13.3, 1);
    expect(responseDb(500)).toBeCloseTo(0.0, 1);
    expect(responseDb(1_000)).toBeCloseTo(0.7, 1);
    expect(responseDb(10_000)).toBeCloseTo(4.0, 1);
  });

  it('rises monotonically across the audible band', () => {
    // K-weighting is a low-frequency roll-off followed by a high-frequency shelf, with
    // no ripple between them; a non-monotonic response would mean a coefficient error.
    const probes = [20, 40, 100, 200, 500, 1_000, 2_000, 4_000, 10_000];
    const magnitudes = probes.map((frequencyHz) =>
      kWeightingMagnitudeAt(frequencyHz, TEST_SAMPLE_RATE),
    );

    for (let index = 1; index < magnitudes.length; index += 1) {
      expect(magnitudes[index]).toBeGreaterThan(magnitudes[index - 1] ?? 0);
    }
  });
});

describe('integrated loudness (Requirements 21.11, 21.15)', () => {
  const tone = sine(1_000, frames(3_000), 0.5);

  it('measures a full-scale 1 kHz sine as -3.01 LUFS', () => {
    // BS.1770's canonical calibration point, and the one number in this file that fixes
    // the measurement's *absolute* scale rather than a relation between two of its
    // outputs. A sine's mean square is half its peak square, and the standard's -0.691
    // offset together with the +0.70 dB of K-weighting at 1 kHz turns that into -3.01.
    const fullScale = sine(1_000, frames(3_000), 1.0);

    expect(integratedLoudnessLufs(monoAudio(fullScale))).toBeCloseTo(-3.01, 1);
  });

  it('measures a -6 dBFS 1 kHz sine 6 dB below the full-scale one', () => {
    const fullScale = sine(1_000, frames(3_000), 1.0);
    const halved = sine(1_000, frames(3_000), 0.5);

    expect(
      integratedLoudnessLufs(monoAudio(fullScale)) - integratedLoudnessLufs(monoAudio(halved)),
    ).toBeCloseTo(20 * Math.log10(2), 4);
  });

  it('moves by exactly 20·log10(g) when the buffer is scaled by g', () => {
    // The relation Requirement 21.11's ladder depends on: a 3.0 LUFS step is a gain
    // step, and the measurement must report it as one.
    const base = integratedLoudnessLufs(monoAudio(tone));

    for (const gainDb of [-12, -6, -3, 3, 6]) {
      const gain = 10 ** (gainDb / 20);
      const scaledLoudness = integratedLoudnessLufs(monoAudio(scaled(tone, gain)));

      expect(scaledLoudness - base).toBeCloseTo(gainDb, 6);
    }
  });

  it('is deterministic: the same buffer measures identically every time', () => {
    // Requirement 21.11 is stated as an invariant, which a stochastic measurement could
    // not support.
    const first = integratedLoudnessLufs(monoAudio(tone));
    const second = integratedLoudnessLufs(monoAudio(Float32Array.from(tone)));

    expect(second).toBe(first);
  });

  it('measures a duplicated-to-stereo signal 3.01 LU above the mono original', () => {
    // The standard's channel summation, stated as a test so the behaviour is documented
    // rather than surprising. Every channel weighs 1.0, so two identical channels double
    // the summed mean square.
    const mono = monoAudio(tone);
    expect(CHANNEL_WEIGHT_G).toBe(1.0);
    expect(integratedLoudnessLufs(duplicatedToStereo(mono)) - integratedLoudnessLufs(mono))
      .toBeCloseTo(10 * Math.log10(2), 6);
  });

  it('reports -Infinity for silence rather than a floor value', () => {
    // A floor would make the difference between two silent variants look like a
    // satisfied 0 LUFS step instead of an unmeasurable one.
    expect(integratedLoudnessLufs(monoAudio(new Float32Array(frames(1_000))))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('reports -Infinity when every block sits below the absolute gate', () => {
    // A signal 100 dB down is below BS.1770-4's -70 LUFS absolute gate everywhere.
    const inaudible = scaled(tone, 10 ** (-100 / 20));
    const loudness = integratedLoudnessLufs(monoAudio(inaudible));

    expect(loudness).toBe(Number.NEGATIVE_INFINITY);
    expect(LOUDNESS_ABSOLUTE_GATE_LUFS).toBe(-70);
  });

  it('measures a buffer shorter than one 400 ms gating block', () => {
    // Requirement 21.2 permits a 5-second minimum, and Requirement 22 shorter still, so
    // an unmeasurable short buffer would be a real gap. A 100 ms tone must yield a
    // finite number.
    const short = sine(1_000, frames(100), 0.5);

    expect(Number.isFinite(integratedLoudnessLufs(monoAudio(short)))).toBe(true);
  });

  it('is unmeasurable for malformed audio rather than throwing', () => {
    const raggedChannels = { sampleRate: 48_000, channels: [tone, tone.slice(0, 10)] };

    expect(integratedLoudnessLufs(raggedChannels)).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudnessLufs({ sampleRate: 0, channels: [tone] })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('gates out a quiet passage so it does not drag the measurement down', () => {
    // BS.1770-4's gates exist so that silence between phrases is not averaged in. A tone
    // followed by an equal length of silence must measure close to the tone alone rather
    // than the 3.01 dB below it that an ungated mean would give.
    const withSilence = new Float32Array(tone.length * 2);
    withSilence.set(tone, 0);

    const gated = integratedLoudnessLufs(monoAudio(withSilence));
    const toneAlone = integratedLoudnessLufs(monoAudio(tone));

    // Not exact, and correctly so: the blocks straddling the tone-to-silence boundary
    // are partially filled, sit only ~3 dB down, and therefore survive the -10 LU
    // relative gate. They pull the result a fraction of a dB down, not 3 dB.
    expect(toneAlone - gated).toBeGreaterThan(0);
    expect(toneAlone - gated).toBeLessThan(0.5);
  });
});

describe('level arithmetic (Requirements 21.7, 21.8, 21.16)', () => {
  it('measures the RMS of an alternating-sign signal as exactly its amplitude', () => {
    expect(rmsOf(alternating(1_000, 0.25))).toBeCloseTo(0.25, 12);
  });

  it('measures the RMS of a whole-cycle sine as amplitude over root two', () => {
    // 480 samples at 48 kHz is exactly one cycle of 100 Hz.
    expect(rmsOf(sine(100, 480, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 6);
  });

  it('measures peak as the largest absolute sample, whatever its sign', () => {
    expect(peakAbs(Float32Array.from([0.1, -0.9, 0.4]))).toBeCloseTo(0.9, 6);
  });
});
