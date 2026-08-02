/**
 * A `CueMfccPort` for the tests. **Not** Requirement 24.9's measurement.
 *
 * That distinction is the whole point of this file, so it is stated first and plainly.
 *
 * Requirement 24.9's MFCC — 48 kHz mono, −23 LUFS, 25 ms windows at 10 ms intervals, 40 mel
 * bands, coefficients 1…13 averaged over time — is implemented **once**, in
 * `dsp/src/musicstudio_dsp/mfcc.py`, and is tested there against the HTK mel formula, against
 * analytic band edges, and over a real 78-cue pack's 3003 pairs. `services/sound/sound-pack-ports.ts`
 * explains why it is not reimplemented in TypeScript: an FFT, a mel filterbank and a DCT-II are
 * not checkable against published test vectors the way a K-weighted mean square is, and two of
 * them disagreeing by half a percent would put pairs on opposite sides of 0.95 depending on
 * which side of the process boundary the comparison ran.
 *
 * What the TypeScript side needs is a port implementation that is a *genuine function of the
 * audio*, so that the pack-level behaviour — the exhaustive 3003-pair scan, the verdict, and
 * Requirement 24.22's reseeded remedy — is exercised over cues that really do differ and really
 * do resemble each other. A constant vector, or one derived from the cue's *name*, would make
 * every similarity assertion pass without evidence.
 *
 * So this computes a **band-energy cepstrum**: 40 mel-spaced band energies over one analysis
 * window, log-compressed, then a DCT-II keeping coefficients 1…13. Same shape and same
 * dimension as the real thing, same mel spacing, same dropped `c0` — and therefore the same two
 * properties the pack logic depends on:
 *
 * - **level invariance.** Dropping `c0` removes the only coefficient a uniform gain moves, so
 *   the vector does not change when the cue is scaled. That is what makes Requirement 24.9's
 *   −23 LUFS normalisation a no-op for the coefficients it keeps, and it is asserted here.
 * - **spectral sensitivity.** Two cues with different spectral envelopes get different vectors,
 *   and two cues with the same envelope at different pitches get similar ones.
 *
 * What it is *not*: it takes one window rather than averaging over frames, it uses a naive DFT
 * at band centres rather than an FFT and triangular filters, and it does not resample or
 * normalise (it does not need to — see level invariance). Its numbers are therefore **not**
 * comparable with the Python implementation's, and nothing asserts that they are.
 */

import { channelCount, frameCount, type PcmAudio } from '../../domain/audio/pcm';
import {
  CUE_MFCC_DIMENSIONS,
  CUE_MFCC_MEL_BANDS,
} from '../../domain/sound-pack/bounds';
import type { CueMfccVector } from '../../domain/sound-pack/similarity';
import type { CueMfccPort, PackCueAudio } from '../../services/sound/sound-pack-ports';

/**
 * Samples analysed, at most.
 *
 * 2 048 at 48 kHz is 43 ms, which resolves the mel spacing well enough to separate 78 spectral
 * envelopes while keeping the cost of the naive DFT bounded: 40 bands × 3 probes × 2 048
 * samples is about 250 000 multiplications per cue, so a whole pack costs a fraction of a
 * second — and a pack is measured up to four times when Requirement 24.22's remedy runs. An
 * unbounded window would make a 4-second loop cue thirty times more expensive than a 150 ms
 * one-shot for no gain in what is being measured.
 */
export const DESCRIPTOR_WINDOW_FRAMES = 2_048;

/** Probes per band, summed. One would make a band's energy depend on a single bin. */
const PROBES_PER_BAND = 3;

/** Floor on a band energy before the logarithm, so a silent band is finite. */
const LOG_FLOOR = 1e-10;

/** HTK's mel scale, the same formula the Python module uses. */
export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Band edge frequencies, `bands + 1` of them, evenly spaced on the mel scale. */
export function melBandEdges(sampleRate: number, bands: number): readonly number[] {
  const top = hzToMel(sampleRate / 2);
  return Array.from({ length: bands + 1 }, (_unused, index) => melToHz((top * index) / bands));
}

/** Mono mix of the analysis window, as plain numbers. */
function analysisWindow(audio: PcmAudio): readonly number[] {
  const frames = Math.min(frameCount(audio), DESCRIPTOR_WINDOW_FRAMES);
  const channels = channelCount(audio);
  const window = new Array<number>(frames).fill(0);

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (const channel of audio.channels) sum += channel[frame] ?? 0;
    window[frame] = channels === 0 ? 0 : sum / channels;
  }
  return window;
}

/** `|X(f)|²` by direct evaluation, for one frequency. */
function binEnergy(window: readonly number[], frequency: number, sampleRate: number): number {
  const step = (2 * Math.PI * frequency) / sampleRate;
  let real = 0;
  let imaginary = 0;
  for (const [index, sample] of window.entries()) {
    real += sample * Math.cos(step * index);
    imaginary -= sample * Math.sin(step * index);
  }
  return real * real + imaginary * imaginary;
}

/** Log energy per mel band. */
export function logMelBandEnergies(
  audio: PcmAudio,
  bands: number = CUE_MFCC_MEL_BANDS,
): readonly number[] {
  const window = analysisWindow(audio);
  if (window.length === 0) return new Array<number>(bands).fill(Math.log(LOG_FLOOR));

  const edges = melBandEdges(audio.sampleRate, bands);
  return Array.from({ length: bands }, (_unused, band) => {
    const low = edges[band] as number;
    const high = edges[band + 1] as number;
    let energy = 0;
    for (let probe = 0; probe < PROBES_PER_BAND; probe += 1) {
      const frequency = low + ((high - low) * (probe + 0.5)) / PROBES_PER_BAND;
      energy += binEnergy(window, frequency, audio.sampleRate);
    }
    // Divided by the window length so the value is a mean rather than a sum, which keeps the
    // magnitudes comparable between a 150 ms one-shot and a 600 ms loop.
    return Math.log(Math.max(LOG_FLOOR, energy / window.length));
  });
}

/**
 * DCT-II, coefficients 1…13 — `c0` dropped.
 *
 * `c0` is proportional to the mean log energy, which is exactly what a uniform gain moves. It is
 * dropped for the reason Requirement 24.9 drops it (the clause says "1차부터 13차까지"), and
 * that is what makes the vector level-invariant.
 */
export function cepstrumFromLogMel(
  logMel: readonly number[],
  coefficients: number = CUE_MFCC_DIMENSIONS,
): readonly number[] {
  const bands = logMel.length;
  return Array.from({ length: coefficients }, (_unused, index) => {
    const order = index + 1;
    let total = 0;
    for (const [band, value] of logMel.entries()) {
      total += value * Math.cos((Math.PI * order * (band + 0.5)) / bands);
    }
    return (total * 2) / bands;
  });
}

/** The 13-dimension descriptor of one cue. */
export function cueDescriptor(audio: PcmAudio): readonly number[] {
  return cepstrumFromLogMel(logMelBandEnergies(audio));
}

/**
 * A `CueMfccPort` over `cueDescriptor`.
 *
 * Memoised on the buffer identity, because Requirement 24.22's remedy re-measures the whole
 * pack after each round and 77 of the 78 buffers are the same objects as before.
 */
export function createDescriptorMfccPort(): CueMfccPort {
  const cache = new WeakMap<PcmAudio, readonly number[]>();

  return {
    measureCueMfcc: async (cues: readonly PackCueAudio[]): Promise<readonly CueMfccVector[]> =>
      cues.map((cue) => {
        const cached = cache.get(cue.audio);
        const coefficients = cached ?? cueDescriptor(cue.audio);
        if (cached === undefined) cache.set(cue.audio, coefficients);
        return { cueName: cue.cueName, coefficients };
      }),
  };
}
