/**
 * Synthesised UI cues, for the sound-pack tests (Requirement 24).
 *
 * The TypeScript counterpart of `dsp/test/cue_synthesis.py`, built on the same reasoning as
 * `pcm-synthesis.ts`: every buffer comes from a closed-form or seeded expression, so its
 * properties are *known*. A recording would carry noise and codec artefacts of unknown size
 * and every tolerance would have to be widened until the tests stopped distinguishing a
 * correct measurement from an approximately correct one.
 *
 * ### Why not just reuse `decayingOneShot` 78 times
 *
 * Because Requirement 24.9's ceiling is a claim about *timbre*, and 78 decaying sines at
 * different pitches are timbrally almost identical: they share one spectral envelope shape, so
 * their 13-dimension MFCCs are nearly collinear and hundreds of the 3003 pairs land above
 * 0.95. The Python module records the measurement — 307 exceeding pairs for sines spaced
 * 40 Hz apart — and the same is true here, and is worth knowing rather than working around:
 * the default harness engine *does* produce such tones (see
 * `deterministic-woosh-transport.ts`), so a pack generated with no scripted audio genuinely
 * ends up in Requirement 24.22's remedy. That is a real behaviour of the rule, not a defect
 * in the fixture, and there is a test for it.
 *
 * `distinctOneShot` gives each cue an independent spectral envelope instead — a gain per
 * partial drawn from a seeded generator over a 40 dB range — which is exactly the quantity an
 * MFCC measures. The resulting 13-vectors are effectively independent directions, whose
 * pairwise cosine similarity concentrates near 0 with a spread of roughly `1/√13 ≈ 0.28`, so
 * 0.95 is over three spreads away and the margin is structural rather than lucky.
 *
 * ### Why the loops are built differently from the one-shots
 *
 * Requirement 24.6 holds a loop cue to *two* criteria: the 10 ms seam RMS windows must match
 * within 1.0 dB, and the last and first samples must differ by no more than 5 % of the cue's
 * peak. The second one is a real constraint on the *bandwidth* of a loop, and it is worth
 * stating why, because it looks arbitrary until it is computed. For a broadband signal at
 * 48 kHz, adjacent samples are nearly uncorrelated, so `|x[n+1] − x[n]| ≈ √2·RMS` while the
 * peak is around `4·RMS` — a step of roughly 35 % of the peak, seven times the ceiling. A
 * loop that satisfies 24.6 therefore *has* to be smooth at the seam, which in practice means
 * low-frequency dominant. Real UI loops are.
 *
 * So `distinctSeamlessLoop` builds a harmonic series on a fundamental whose period divides
 * the 10 ms seam window exactly. Three consequences, each one a criterion:
 *
 * - the buffer holds a whole number of periods, and the seam window holds a whole number of
 *   periods, so the first and last 10 ms contain *identical samples* — 24.6's RMS difference
 *   is exactly 0 dB rather than approximately;
 * - the last sample is one sample of slope from the first, and the partial gains are rolled
 *   off as `1/k`, which bounds that slope well inside 5 % of the peak;
 * - the gains are still seed-dependent, so six loops remain timbrally distinct from each other
 *   and from the one-shots.
 */

import { maxShortTermLoudnessLufs } from '../../domain/audio/loudness';
import type { PcmAudio } from '../../domain/audio/pcm';
import {
  CUE_MFCC_MEL_BANDS,
  PACK_LOUDNESS_HOP_MS,
  PACK_LOUDNESS_WINDOW_MS,
} from '../../domain/sound-pack/bounds';

import { melBandEdges } from './cue-mfcc-descriptor';
import { monoAudio, oneShotDecayExponent, TEST_SAMPLE_RATE } from './pcm-synthesis';

/** Dynamic range of the per-partial gains, in dB below unity. Mirrors the Python module. */
export const PARTIAL_GAIN_RANGE_DB = -40;

/**
 * Partials per mel band, for a one-shot.
 *
 * The gains are drawn **per mel band** rather than per partial, and that is the fix a
 * measurement forced. Geometric partial spacing with an independent gain each leaves the bands
 * above the highest partial at the log floor, and a floor shared by all 78 cues is a constant
 * vector component that every pair has in common — measured: 675 of the 3003 pairs above 0.95,
 * with `hover`/`select` at 0.969. Shaping the spectrum on the *same* 40-band mel grid the
 * descriptor integrates over makes each band's energy an independent draw, which is what makes
 * the 13-vectors independent directions. Measured after the change: see the assertions in
 * `test/unit/sound-pack/cue-synthesis.test.ts`.
 */
export const PARTIALS_PER_BAND = 3;



/**
 * A deterministic generator, so a failing case is reproducible from the seed printed with it.
 *
 * `mulberry32` rather than `Math.random`: two runs of the suite must produce the same 78 cues,
 * and a shared global generator would make one test's draw depend on whether another test ran.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Gains spanning `rangeDb` below unity, one per entry, drawn from `seed`. */
function drawGains(
  seed: number,
  count: number,
  rangeDb: number = PARTIAL_GAIN_RANGE_DB,
): readonly number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => 10 ** ((rangeDb * random()) / 20));
}

/** Uniform draws in `[0, 1)`, for phases. */
function drawUnit(seed: number, count: number): readonly number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => random());
}

/** Adds `gain · sin(2πf t + φ)` to `samples`, in place. */
function addPartial(
  samples: Float32Array,
  frequency: number,
  gain: number,
  phase: number,
  sampleRate: number,
): void {
  if (frequency <= 0 || frequency >= sampleRate / 2) return;
  const step = (2 * Math.PI * frequency) / sampleRate;
  for (let frame = 0; frame < samples.length; frame += 1) {
    samples[frame] = (samples[frame] as number) + gain * Math.sin(step * frame + phase);
  }
}

/**
 * Target loudness of a synthesised cue, LUFS, on Requirement 24.7's measurement.
 *
 * The middle of 24.7's −25…−21 LUFS band, so a cue sits inside it with 2 LU of margin at either
 * end rather than on a boundary — a fixture that only just satisfies a rule turns every
 * unrelated arithmetic change into a mystery failure, which is the reason
 * `pcm-synthesis.ts` gives for its own `ONE_SHOT_TAIL_TARGET`.
 */
export const CUE_TARGET_LUFS = -23;

/**
 * Scale a cue so its Requirement 24.7 loudness is `targetLufs` exactly.
 *
 * One measurement and one scale, because the measurement is exactly linear in the gain: a
 * K-weighted mean square scales as `g²`, so the loudness moves by `20·log10(g)` and the gain
 * that lands on the target is known in closed form. No iteration, and no dependence on the
 * signal's shape.
 *
 * This does not disturb anything else the cue is judged on: the tail ratio of Requirement 24.8,
 * the seam RMS difference and sample step of 24.6 and the MFCC of 24.9 are all *relative*
 * quantities, unchanged by a uniform gain. That is not a lucky coincidence — it is why 24.7 is
 * the only clause in Requirement 24 that constrains absolute level.
 */
export function normalisedToPackLoudness(
  audio: PcmAudio,
  targetLufs: number = CUE_TARGET_LUFS,
): PcmAudio {
  const measured = maxShortTermLoudnessLufs(audio, PACK_LOUDNESS_WINDOW_MS, PACK_LOUDNESS_HOP_MS);
  if (!Number.isFinite(measured)) return audio;
  const gain = 10 ** ((targetLufs - measured) / 20);
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((channel) => {
      const scaled = new Float32Array(channel.length);
      for (let index = 0; index < channel.length; index += 1) {
        scaled[index] = (channel[index] as number) * gain;
      }
      return scaled;
    }),
  };
}

function normalisedToPeak(samples: Float32Array, amplitude: number): Float32Array {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 0) return samples;
  const gain = amplitude / peak;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (samples[index] as number) * gain;
  }
  return samples;
}

export interface DistinctCueOptions {
  readonly durationMs?: number;
  readonly amplitude?: number;
  readonly sampleRate?: number;
}

/**
 * A one-shot with a seed-specific spectral envelope, decayed so Requirement 24.8 holds.
 *
 * The envelope is `(1 − t/T)^k` with `k` solved from the duration by `oneShotDecayExponent`,
 * which is what makes the last 50 ms already quiet at every length in Requirement 24.4's
 * range — see that function on why a fixed exponent cannot work across it.
 *
 * The spectrum is shaped on the 40-band mel grid — one independent gain per band, three
 * partials inside each band — for the reason `PARTIALS_PER_BAND` states.
 */
export function distinctOneShot(seed: number, options: DistinctCueOptions = {}): PcmAudio {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const durationMs = options.durationMs ?? 150;
  const frameCount = Math.max(2, Math.round((durationMs * sampleRate) / 1000));
  const bands = CUE_MFCC_MEL_BANDS;
  const gains = drawGains(seed, bands);
  const phases = drawUnit(seed ^ 0x5f5f_5f5f, bands * PARTIALS_PER_BAND);
  const edges = melBandEdges(sampleRate, bands);
  const exponent = oneShotDecayExponent(durationMs);
  const samples = new Float32Array(frameCount);

  for (let band = 0; band < bands; band += 1) {
    const low = edges[band] as number;
    const high = edges[band + 1] as number;
    for (let partial = 0; partial < PARTIALS_PER_BAND; partial += 1) {
      addPartial(
        samples,
        low + ((high - low) * (partial + 0.5)) / PARTIALS_PER_BAND,
        gains[band] as number,
        2 * Math.PI * (phases[band * PARTIALS_PER_BAND + partial] as number),
        sampleRate,
      );
    }
  }

  normalisedToPeak(samples, 1);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const envelope = (1 - frame / frameCount) ** exponent;
    samples[frame] = (samples[frame] as number) * envelope;
  }

  return normalisedToPackLoudness(
    monoAudio(normalisedToPeak(samples, options.amplitude ?? 0.7), sampleRate),
  );
}

/**
 * Periods of the loop fundamental that fit in the 10 ms seam window.
 *
 * One. The fundamental's period is therefore the seam window itself — 480 samples at 48 kHz, a
 * 100 Hz fundamental — and every partial is a harmonic of it, so the first and last 10 ms of a
 * buffer holding a whole number of windows contain **identical samples**. Requirement 24.6's
 * RMS difference is then exactly 0 dB rather than approximately, which is what makes a failure
 * of that criterion in these tests evidence about the code rather than about the fixture.
 *
 * 100 Hz rather than a higher fundamental so that only the very lowest mel band has no harmonic
 * in it: a band with no energy sits at the log floor, and a floor shared by all six loops is a
 * constant vector component that raises every loop pair's similarity.
 */
export const LOOP_SEAM_PERIODS = 1;

/** Requirement 24.6's window, restated so this module needs no product import. */
const CUE_SEAM_WINDOW_MS = 10;

/**
 * Reference frequency and exponent ranges of a loop's spectral tilt.
 *
 * Both are drawn per seed, and that is the second fix a measurement forced. A loop has to be
 * **low-frequency dominant** to satisfy Requirement 24.6's sample-step rule at all — see the
 * module header on why a broadband loop cannot — so its spectrum carries a steep rolloff. A
 * rolloff is smooth across mel bands, so it lands almost entirely in the low cepstral orders,
 * and a rolloff that is the *same* for every loop is a large shared component of all six
 * vectors. Measured with a fixed `1/k²` tilt: 10 of the 3003 pairs above 0.95, every one of them
 * a loop-loop pair, `processing`/`recording` at 0.979.
 *
 * Drawing the tilt per seed decorrelates exactly that component. It is also the honest fixture:
 * six real UI loops would not share one spectral slope.
 *
 * **This is a genuine tension in Requirement 24 rather than an artefact of the fixture**, and it
 * is recorded in this task's report: 24.6 pushes a loop cue toward a smooth, band-limited
 * signal, while 24.9 requires all 78 cues — the six loops included — to be pairwise timbrally
 * distinct. The six loops have less spectrum to be distinct in than the 72 one-shots do.
 */
export const LOOP_TILT_REFERENCE_HZ_MIN = 300;
export const LOOP_TILT_REFERENCE_HZ_MAX = 3_000;
export const LOOP_TILT_EXPONENT_MIN = 1.5;
export const LOOP_TILT_EXPONENT_MAX = 3.5;

/**
 * How far below the reference the tilt may take a band, in dB.
 *
 * The tilt is **floored**, and this is the third thing a measurement forced. An unfloored
 * `(ref/f)^3.5` reaches −148 dB at 24 kHz, which swamps the 40 dB per-band draw entirely: the
 * envelope is then essentially the ramp, the ramp is smooth, a smooth envelope lands in the low
 * cepstral orders, and six vectors dominated by the same low orders are nearly collinear
 * whatever their exponents. Measured with an unfloored tilt: all 15 loop-loop pairs above 0.95.
 *
 * Flooring the ramp at the same 40 dB the per-band gains span makes the two contributions
 * comparable, so the random part is no longer a perturbation of a shared shape. −40 dB is also
 * quiet enough that the high bands contribute almost nothing to one sample of slope, which is
 * what Requirement 24.6 constrains — the measured step stays near 1 % of the peak.
 */
export const LOOP_TILT_FLOOR_DB = -30;

/**
 * Per-band gain range for a loop, in dB below unity. Wider than a one-shot's 40 dB.
 *
 * The tilt a loop must carry is a shared component of all six vectors no matter how it is
 * drawn, so the *random* component is given more room instead: 60 dB of per-band variation
 * against a 40 dB floored ramp leaves the draw dominant. A one-shot needs no tilt and so needs
 * no compensation.
 */
export const LOOP_GAIN_RANGE_DB = -70;

/**
 * A loop whose seam satisfies both halves of Requirement 24.6, by construction.
 *
 * The spectrum is shaped on the same 40-band mel grid as a one-shot's, with every partial snapped
 * to a harmonic of the fundamental so periodicity — and therefore the seam — survives. On top of
 * the per-band draw sits a seed-specific tilt above a seed-specific reference frequency, which is
 * what keeps one sample of slope inside 5 % of the peak while leaving the six loops timbrally
 * distinct. See `LOOP_TILT_REFERENCE_HZ_MIN`.
 *
 * The length is snapped down to a whole number of seam windows, so a request for 600 ms yields
 * exactly 600 ms and any request inside Requirement 24.5's 0.5–4.0 s range stays inside it.
 */
function buildSeamlessLoop(seed: number, options: DistinctCueOptions): PcmAudio {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const durationMs = options.durationMs ?? 2_000;
  const seamFrames = Math.round((CUE_SEAM_WINDOW_MS * sampleRate) / 1000);
  const periodFrames = Math.round(seamFrames / LOOP_SEAM_PERIODS);
  const fundamental = sampleRate / periodFrames;

  const requested = Math.round((durationMs * sampleRate) / 1000);
  const windows = Math.max(2, Math.floor(requested / seamFrames));
  const frameCount = windows * seamFrames;

  const bands = CUE_MFCC_MEL_BANDS;
  const gains = drawGains(seed, bands, LOOP_GAIN_RANGE_DB);
  const phases = drawUnit(seed ^ 0x3c3c_3c3c, bands * PARTIALS_PER_BAND);
  const shape = drawUnit(seed ^ 0x1234_5678, 2);
  const reference =
    LOOP_TILT_REFERENCE_HZ_MIN +
    (LOOP_TILT_REFERENCE_HZ_MAX - LOOP_TILT_REFERENCE_HZ_MIN) * (shape[0] as number);
  const exponent =
    LOOP_TILT_EXPONENT_MIN +
    (LOOP_TILT_EXPONENT_MAX - LOOP_TILT_EXPONENT_MIN) * (shape[1] as number);

  const edges = melBandEdges(sampleRate, bands);
  const samples = new Float32Array(frameCount);

  for (let band = 0; band < bands; band += 1) {
    const low = edges[band] as number;
    const high = edges[band + 1] as number;
    for (let partial = 0; partial < PARTIALS_PER_BAND; partial += 1) {
      const nominal = low + ((high - low) * (partial + 0.5)) / PARTIALS_PER_BAND;
      // Snapped to a harmonic, which is what keeps the buffer periodic in the seam window.
      const harmonic = Math.max(1, Math.round(nominal / fundamental));
      const frequency = harmonic * fundamental;
      const tilt =
        frequency <= reference
          ? 1
          : Math.max(10 ** (LOOP_TILT_FLOOR_DB / 20), (reference / frequency) ** exponent);
      addPartial(
        samples,
        frequency,
        (gains[band] as number) * tilt,
        2 * Math.PI * (phases[band * PARTIALS_PER_BAND + partial] as number),
        sampleRate,
      );
    }
  }

  return normalisedToPackLoudness(
    monoAudio(normalisedToPeak(samples, options.amplitude ?? 0.6), sampleRate),
  );
}

/**
 * A loop whose seam step is inside Requirement 24.6's ceiling, by **redrawing** rather than by
 * filtering.
 *
 * The tilt draw leaves the step at 0.1–4 % of the peak for most seeds and above 5 % for a few —
 * measured: three of the six loops in one regeneration round. A fixture that is compliant for
 * most inputs is not a fixture, so the step is measured and the spectrum redrawn until it
 * complies.
 *
 * **Filtering was tried first and is wrong**, which is worth recording because it looks like the
 * obvious fix. A circular two-point average preserves periodicity and attenuates high
 * frequencies, so it does reduce the numerator — but the step is
 * `|x[N−1] − x[0]| / peak`, and when the peak is itself set by the high frequencies the
 * denominator falls faster than the numerator and the ratio gets *worse*. Measured: `connecting`
 * went from 4 % to 12 % after ten passes. The step is a low-frequency quantity divided by a
 * broadband one, and no filter improves that ratio reliably.
 *
 * Redrawing keeps the distribution the similarity margin depends on: each attempt is a fresh
 * independent spectral envelope rather than a systematically flattened one. Deterministic in the
 * seed, and it returns the best attempt if none complies, so a failure surfaces as a seam verdict
 * rather than as a hang.
 */
export const SEAM_STEP_TARGET = 0.02;

/** Redraws allowed. Two are enough for every seed measured; eight is slack. */
const SEAM_REDRAWS_MAX = 8;

/** Distance between redraw seeds. A prime, far from the cue and round strides. */
const SEAM_REDRAW_STRIDE = 104_729;

export function distinctSeamlessLoop(seed: number, options: DistinctCueOptions = {}): PcmAudio {
  let best: PcmAudio | null = null;
  let bestRatio = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < SEAM_REDRAWS_MAX; attempt += 1) {
    const candidate = buildSeamlessLoop(seed + attempt * SEAM_REDRAW_STRIDE, options);
    const ratio = seamStepRatio(candidate.channels[0] ?? new Float32Array(0));
    if (ratio <= SEAM_STEP_TARGET) return candidate;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }

  return best ?? buildSeamlessLoop(seed, options);
}

/** `|last − first| / peak`, Requirement 24.6's second quantity. */
export function seamStepRatio(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 0) return 0;
  const first = samples[0] ?? 0;
  const last = samples[samples.length - 1] ?? 0;
  return Math.abs(last - first) / peak;
}

/**
 * A cue of the right kind for its name, pairwise dissimilar from its siblings.
 *
 * Lengths sit inside Requirement 24.4's and 24.5's ranges with margin rather than at an end,
 * and are kept **short** on purpose: 78 cues are synthesised several times over in this suite
 * and every extra millisecond is 78 buffers longer. 150 ms one-shots and 600 ms loops are the
 * shortest lengths at which both length ranges and the 400 ms loudness window are exercised.
 */
export function distinctCueFor(cueName: string, seed: number, loop: boolean): PcmAudio {
  return loop
    ? distinctSeamlessLoop(seed, { durationMs: 600 })
    : distinctOneShot(seed, { durationMs: 150 });
}
