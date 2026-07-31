/**
 * Synthesised PCM, for testing the loop measurements of Requirement 21.
 *
 * Every buffer here is generated in TypeScript from a closed-form expression, so its
 * properties are *known* rather than assumed: the RMS of an alternating-sign signal is
 * exactly its amplitude, a click's peak is the click, a linear fade's last 100 ms is
 * quiet by a computable amount. That is what lets `in-process-measurement.ts` be
 * checked against an independent prediction instead of against itself.
 *
 * Nothing reads a file and nothing decodes anything. A recording would carry noise, DC
 * offset and codec artefacts of unknown size, and every tolerance in these tests would
 * have to be widened to cover them — at which point the tests would no longer
 * distinguish a correct measurement from an approximately correct one.
 */

import type { PcmAudio } from '../../domain/audio/pcm';

/** Design §5.1's rate, used unless a test is specifically about another. */
export const TEST_SAMPLE_RATE = 48_000;

export function frames(durationMs: number, sampleRate = TEST_SAMPLE_RATE): number {
  return Math.round((durationMs * sampleRate) / 1000);
}

export function monoAudio(samples: Float32Array, sampleRate = TEST_SAMPLE_RATE): PcmAudio {
  return { sampleRate, channels: [samples] };
}

export function stereoAudio(
  left: Float32Array,
  right: Float32Array,
  sampleRate = TEST_SAMPLE_RATE,
): PcmAudio {
  return { sampleRate, channels: [left, right] };
}

/** The same channel twice — a mono signal presented as stereo. */
export function duplicatedToStereo(audio: PcmAudio): PcmAudio {
  const channel = audio.channels[0] ?? new Float32Array(0);
  return { sampleRate: audio.sampleRate, channels: [channel, Float32Array.from(channel)] };
}

/**
 * A sine of `frequencyHz`, `frameCount` samples long, starting at phase 0.
 *
 * Deliberately not windowed or faded. A raw sine is the signal whose seam is
 * discontinuous unless the length happens to be a whole number of cycles, which makes
 * it the right probe for both sides of Requirement 21.8: choose a whole-cycle length
 * and the seam is continuous, add half a cycle and it is not.
 */
export function sine(
  frequencyHz: number,
  frameCount: number,
  amplitude = 0.5,
  sampleRate = TEST_SAMPLE_RATE,
): Float32Array {
  const samples = new Float32Array(frameCount);
  const step = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let index = 0; index < frameCount; index += 1) {
    samples[index] = amplitude * Math.sin(step * index);
  }
  return samples;
}

/**
 * Frames of the largest whole number of cycles of `frequencyHz` that fits `targetMs`.
 *
 * A whole number of cycles is what makes the first and last samples meet: the last
 * sample is one step short of the next cycle's zero, so the seam step is bounded by one
 * sample of slope rather than by the amplitude. Used to build the sine loops that are
 * supposed to pass Requirements 21.7 and 21.8.
 */
export function wholeCycleFrames(
  frequencyHz: number,
  targetMs: number,
  sampleRate = TEST_SAMPLE_RATE,
): number {
  const framesPerCycle = sampleRate / frequencyHz;
  const cycles = Math.max(1, Math.floor(frames(targetMs, sampleRate) / framesPerCycle));
  return Math.round(cycles * framesPerCycle);
}

/**
 * Constant magnitude with alternating sign.
 *
 * RMS is exactly `amplitude` over every even-length window and the peak is exactly
 * `amplitude`. That makes it the right subject for testing the RMS and peak arithmetic
 * of `domain/audio/level.ts`, where an exact expected value is worth more than realism.
 *
 * It is *not* a compliant loop: consecutive samples differ by `2 × amplitude`, so its
 * seam step is four times the channel peak and Requirement 21.8 rejects it. Use
 * `compliantLoop` for anything that is supposed to pass.
 */
export function alternating(frameCount: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    samples[index] = index % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
}

/** `samples` with a single sample at `index` replaced — Requirement 21.8's click. */
export function withClickAt(samples: Float32Array, index: number, value: number): Float32Array {
  const copy = Float32Array.from(samples);
  if (index >= 0 && index < copy.length) copy[index] = value;
  return copy;
}

/**
 * `samples` with a linear fade over its last `fadeMs` — Requirement 21.16's failure.
 *
 * A fade-out is the realistic way an engine breaks the edge-energy rule: the audio is
 * musically fine and its seam step is small, yet the last 100 ms sits far below the
 * overall level, so the loop audibly dips every time round.
 */
export function withFadeOut(
  samples: Float32Array,
  fadeMs: number,
  sampleRate = TEST_SAMPLE_RATE,
): Float32Array {
  const copy = Float32Array.from(samples);
  const fadeFrames = Math.min(copy.length, frames(fadeMs, sampleRate));
  const start = copy.length - fadeFrames;
  for (let offset = 0; offset < fadeFrames; offset += 1) {
    const gain = 1 - (offset + 1) / fadeFrames;
    copy[start + offset] = (copy[start + offset] ?? 0) * gain;
  }
  return copy;
}

/** `samples` with a linear fade over its first `fadeMs`. */
export function withFadeIn(
  samples: Float32Array,
  fadeMs: number,
  sampleRate = TEST_SAMPLE_RATE,
): Float32Array {
  const copy = Float32Array.from(samples);
  const fadeFrames = Math.min(copy.length, frames(fadeMs, sampleRate));
  for (let offset = 0; offset < fadeFrames; offset += 1) {
    copy[offset] = (copy[offset] ?? 0) * (offset / fadeFrames);
  }
  return copy;
}

/** Every sample scaled by `gain`, for the loudness-scaling relation. */
export function scaled(samples: Float32Array, gain: number): Float32Array {
  const copy = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    copy[index] = (samples[index] ?? 0) * gain;
  }
  return copy;
}

/** A whole number of bars at `bpm`, in samples — Requirement 21.17's subject. */
export function barAlignedFrames(
  bpm: number,
  timeSignature: number,
  barCount: number,
  sampleRate = TEST_SAMPLE_RATE,
): number {
  const barMs = (60_000 / bpm) * timeSignature;
  return Math.round((barMs * barCount * sampleRate) / 1000);
}

export interface CompliantLoopOptions {
  readonly bpm: number;
  readonly timeSignature: number;
  readonly barCount: number;
  readonly amplitude?: number;
  readonly sampleRate?: number;
  /** Approximate tone frequency; the exact one is snapped to the bar. */
  readonly approxFrequencyHz?: number;
}

/**
 * Nominal frequency of the tone filling a compliant loop, Hz.
 *
 * Low enough that one sample of its slope is a small fraction of its amplitude — which
 * is what keeps the seam step of Requirement 21.8 near 1 % rather than near the 5 %
 * ceiling — and high enough that a 10 ms seam window still holds a whole cycle, which
 * is what makes the two seam windows of Requirement 21.7 measure identically.
 */
const COMPLIANT_LOOP_FREQUENCY_HZ = 100;

/**
 * A loop that satisfies all four criteria of Requirement 21, by construction.
 *
 * `barCount` bars at `bpm`, filled with a sine whose frequency is snapped so that a
 * whole number of cycles fits exactly in one bar. Each criterion then holds for a
 * stateable reason rather than by luck:
 *
 * - **21.7** — a 10 ms window holds a whole number of cycles at both ends, so the two
 *   seam RMS values are equal.
 * - **21.8** — the loop ends a whole number of cycles from phase 0, so the last sample
 *   is one sample of slope away from the first: about 1.3 % of the peak.
 * - **21.16** — no fade anywhere, so the edge windows measure the overall level.
 * - **21.17** — the length is `barCount` bars exactly.
 *
 * This is the baseline every "one criterion now fails" test perturbs in exactly one way,
 * which is what makes such a test evidence about that criterion alone.
 */
export function compliantLoop(options: CompliantLoopOptions): {
  readonly audio: PcmAudio;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly frequencyHz: number;
} {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const barSeconds = (60 / options.bpm) * options.timeSignature;
  // Snapping the frequency to a whole number of cycles per bar is what makes the seam
  // land at the phase it started from, for any tempo and time signature.
  const cyclesPerBar = Math.max(
    1,
    Math.round((options.approxFrequencyHz ?? COMPLIANT_LOOP_FREQUENCY_HZ) * barSeconds),
  );
  const frequencyHz = cyclesPerBar / barSeconds;
  const frameCount = barAlignedFrames(
    options.bpm,
    options.timeSignature,
    options.barCount,
    sampleRate,
  );

  return {
    audio: monoAudio(
      sine(frequencyHz, frameCount, options.amplitude ?? 0.5, sampleRate),
      sampleRate,
    ),
    durationMs: (frameCount * 1000) / sampleRate,
    frameCount,
    frequencyHz,
  };
}


/**
 * Envelope level the tail window must already be below, as a fraction of the peak.
 *
 * 0.02 rather than the 0.05 of Requirement 22.15's initial threshold, so a buffer built by
 * `decayingOneShot` sits inside the ceiling with margin rather than on it — a fixture that only
 * just passes turns every unrelated arithmetic change into a mystery failure.
 */
const ONE_SHOT_TAIL_TARGET = 0.02;

/** Requirement 22.15's window, restated here so this module needs no product import. */
const ONE_SHOT_TAIL_WINDOW_MS = 50;

export interface OneShotOptions {
  readonly durationMs: number;
  readonly frequencyHz?: number;
  readonly amplitude?: number;
  readonly sampleRate?: number;
}

/**
 * A tone under a decaying envelope that satisfies Requirement 22.15 **by construction**.
 *
 * The analogue of `compliantLoop`: the shape is chosen so the criterion holds for a stateable
 * reason rather than by luck. The envelope is `(1 − t/T)^k`, and `k` is solved from the duration
 * so that the envelope is already at `ONE_SHOT_TAIL_TARGET` when the last 50 ms begins:
 *
 *     (50 / T)^k = 0.02   ⇒   k = ln(0.02) / ln(50 / T)
 *
 * Deriving the exponent from the length rather than fixing it is not a detail — it is the whole
 * point, and a property test is what forced it. **A fixed exponent cannot work across
 * Requirement 22.4's length range.** With a fixed fourth power, a 2-second effect has an envelope
 * of `(0.025)^4 ≈ 4 × 10⁻⁷` at the start of its tail and passes easily, while a 0.1-second effect —
 * the shortest 22.4 permits — has `(0.5)^4 = 0.0625`, above the 5 % ceiling, and fails. That is a
 * genuine tension between 22.4's 0.1 s floor and 22.15's 50 ms window: at the floor, half the
 * asset *is* the tail window, so the second half of the effect has to be essentially silent. See
 * the test "the 0.1 s floor of 22.4 leaves 22.15 barely satisfiable" in
 * `test/unit/sfx/tail-decay.test.ts`, which pins the arithmetic.
 *
 * For a buffer at or below twice the tail window the exponent is undefined (the whole buffer is
 * tail) and is clamped; such a buffer cannot satisfy 22.15 unless it is silent, which is the
 * tension above rather than a defect here.
 */
export function decayingOneShot(options: OneShotOptions): PcmAudio {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const frameCount = Math.max(1, frames(options.durationMs, sampleRate));
  const amplitude = options.amplitude ?? 0.8;
  const step = (2 * Math.PI * (options.frequencyHz ?? 220)) / sampleRate;
  const exponent = oneShotDecayExponent(options.durationMs);
  const samples = new Float32Array(frameCount);

  for (let index = 0; index < frameCount; index += 1) {
    const envelope = (1 - index / frameCount) ** exponent;
    samples[index] = amplitude * envelope * Math.sin(step * index);
  }

  return monoAudio(samples, sampleRate);
}

/** The exponent that puts the envelope at `ONE_SHOT_TAIL_TARGET` when the tail window starts. */
export function oneShotDecayExponent(durationMs: number): number {
  const tailFraction = ONE_SHOT_TAIL_WINDOW_MS / Math.max(durationMs, 1);
  // A buffer no longer than the window has no room to decay inside; 2 keeps the shape sane.
  if (!(tailFraction < 1)) return 2;
  return Math.max(2, Math.log(ONE_SHOT_TAIL_TARGET) / Math.log(tailFraction));
}

/**
 * A tone at constant level for its whole length — Requirement 22.15's failing case.
 *
 * The tail peak equals the overall peak, so the ratio is 1.0 against a 0.05 ceiling: not a
 * marginal miss but an unambiguous one, which is what makes a test using it evidence about
 * the rule rather than about the threshold.
 */
export function sustainedOneShot(options: OneShotOptions): PcmAudio {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const frameCount = Math.max(1, frames(options.durationMs, sampleRate));
  return monoAudio(
    sine(options.frequencyHz ?? 220, frameCount, options.amplitude ?? 0.8, sampleRate),
    sampleRate,
  );
}

/**
 * A seamless loop of `durationMs`, with no tempo — Requirement 22.14's passing case.
 *
 * `compliantLoop` needs a BPM and a time signature because Requirement 21.17 does. A sound
 * effect has neither, and Requirement 22.14 asks only that the two 10 ms seam windows match
 * in RMS — so this snaps the tone to a whole number of cycles in the requested length, which
 * makes the head and tail windows measure identically for the reason
 * `wholeCycleFrames` explains.
 */
export function seamlessSfxLoop(options: OneShotOptions): PcmAudio {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const frequencyHz = options.frequencyHz ?? 200;
  // The length is snapped to the tone rather than the tone to the length, so the buffer holds
  // a whole number of cycles exactly and both seam windows sit at the same phase.
  const frameCount = wholeCycleFrames(frequencyHz, options.durationMs, sampleRate);
  return monoAudio(
    sine(frequencyHz, frameCount, options.amplitude ?? 0.6, sampleRate),
    sampleRate,
  );
}
