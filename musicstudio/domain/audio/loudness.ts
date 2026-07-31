/**
 * Integrated loudness, ITU-R BS.1770-4 (design §5.1; Requirements 21.11, 21.15).
 *
 * The gated measurement, in full: K-weight each channel, take mean square over
 * 400 ms blocks overlapping by 75 %, weight and sum the channels, drop blocks below
 * the absolute gate of −70 LUFS, compute a relative gate 10 LU below the mean of what
 * survived, drop blocks below that too, and report the loudness of the remainder.
 *
 * Why this and not "RMS in dB": Requirement 21.11 bounds the *step* between intensity
 * variants to 1.0–6.0 LUFS, and a step measured on one scale is not the same number on
 * another. A 3 dB RMS step between two mixes with different spectra can be a 1.8 LUFS
 * step or a 4 LUFS one, so the ladder is only checkable against the scale the
 * requirement names.
 *
 * Pure and deterministic: same buffer in, bit-identical number out. The one property
 * the ladder actually leans on — scaling a buffer by `g` moves its loudness by exactly
 * `20·log10(g)` — is a consequence of the filter being linear and the gates being
 * scale-relative, and is pinned as a property test.
 *
 * **Integration point (task 3.1).** The Python worker measures with `pyloudnorm`
 * against the same standard. This implementation is the in-process one the product
 * layer uses when it holds the samples already; the two must agree, and the shared
 * reference is the standard rather than either implementation.
 */

import { kWeightingStages, applyBiquad } from './k-weighting';
import { channelCount, frameCount, isWellFormed, type PcmAudio } from './pcm';

/** BS.1770-4 gating block length and overlap. */
export const LOUDNESS_BLOCK_MS = 400;
export const LOUDNESS_BLOCK_OVERLAP = 0.75;
/** BS.1770-4 absolute gate, LUFS. */
export const LOUDNESS_ABSOLUTE_GATE_LUFS = -70;
/** BS.1770-4 relative gate, LU below the ungated mean. */
export const LOUDNESS_RELATIVE_GATE_LU = 10;
/** BS.1770-4 loudness offset. */
const LOUDNESS_OFFSET = -0.691;

/**
 * BS.1770-4 channel weight `G_i`.
 *
 * The standard weighs left, right and centre at 1.0 and the two surround channels at
 * 1.41. This product stores only mono and stereo audio, so every channel it can ever
 * measure weighs 1.0 — hence one constant rather than a table indexed by channel
 * position. A surround layout would need the 1.41 entries, and adding an untested
 * branch for audio the model cannot hold would be worse than its absence; the shape to
 * change is this constant plus the one multiplication that reads it.
 *
 * A consequence worth stating because it looks like a bug and is not: a mono asset
 * measures 3.01 LU below the same signal duplicated to stereo, since the second channel
 * doubles the summed mean square. That is the standard's behaviour, and it is harmless
 * to Requirement 21.11's ladder, which compares variants of one cue and therefore
 * variants sharing a channel count.
 */
export const CHANNEL_WEIGHT_G = 1.0;

/**
 * Mean square of each 400 ms block, summed over weighted channels.
 *
 * `blockMs` and `hopMs` are parameters so that Requirement 24.7's per-window measurement
 * can reuse this one K-weighting pass instead of growing a second one (see
 * `shortTermLoudnessesLufs` below). Both default to the BS.1770-4 layout, and the default
 * hop is deliberately computed **from `blockSamples`** rather than from `hopMs`: that is
 * the arithmetic the gated measurement has always used, and `round(round(sr·0.4)·0.25)`
 * and `round(sr·0.1)` are not the same integer at every sample rate (they differ by one at
 * 1014 Hz, for instance). Deriving the default from the block keeps
 * `integratedLoudnessLufs` bit-identical to what it computed before this parameter existed
 * — which matters because Requirements 21.11 and 30.8 already compare its output against
 * recorded values.
 */
function blockMeanSquares(
  audio: PcmAudio,
  blockMs: number = LOUDNESS_BLOCK_MS,
  hopMs?: number,
): readonly number[] {
  const stages = kWeightingStages(audio.sampleRate);
  const weighted = audio.channels.map((channel) => {
    let signal = channel;
    for (const stage of stages) signal = applyBiquad(stage, signal);
    return signal;
  });

  const blockSamples = Math.max(1, Math.round((audio.sampleRate * blockMs) / 1000));
  const stepSamples =
    hopMs === undefined
      ? Math.max(1, Math.round(blockSamples * (1 - LOUDNESS_BLOCK_OVERLAP)))
      : Math.max(1, Math.round((audio.sampleRate * hopMs) / 1000));
  const frames = frameCount(audio);
  const channels = channelCount(audio);

  // A buffer shorter than one gating block has no complete block. The standard leaves
  // that undefined; measuring the whole buffer as a single short block is the only
  // answer that keeps a 5-second minimum-length BGM (Requirement 21.2) measurable, and
  // is what `pyloudnorm` does as well.
  const effectiveBlock = Math.min(blockSamples, frames);
  const meanSquares: number[] = [];

  for (let start = 0; start + effectiveBlock <= frames; start += stepSamples) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = weighted[channel];
      if (samples === undefined) continue;
      let channelSum = 0;
      for (let index = start; index < start + effectiveBlock; index += 1) {
        const sample = samples[index] ?? 0;
        channelSum += sample * sample;
      }
      sum += CHANNEL_WEIGHT_G * (channelSum / effectiveBlock);
    }
    meanSquares.push(sum);
  }

  return meanSquares;
}

function loudnessOf(meanSquare: number): number {
  if (meanSquare <= 0) return Number.NEGATIVE_INFINITY;
  return LOUDNESS_OFFSET + 10 * Math.log10(meanSquare);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Integrated loudness in LUFS, or `-Infinity` for silence.
 *
 * `-Infinity` rather than a floor value because Requirement 21.11 subtracts two
 * loudness values, and a floor would make the difference between two silent variants
 * look like a satisfied 0 LUFS step instead of an unmeasurable one.
 */
export function integratedLoudnessLufs(audio: PcmAudio): number {
  if (!isWellFormed(audio)) return Number.NEGATIVE_INFINITY;

  const blocks = blockMeanSquares(audio);
  if (blocks.length === 0) return Number.NEGATIVE_INFINITY;

  const aboveAbsolute = blocks.filter(
    (meanSquare) => loudnessOf(meanSquare) > LOUDNESS_ABSOLUTE_GATE_LUFS,
  );
  if (aboveAbsolute.length === 0) return Number.NEGATIVE_INFINITY;

  const relativeGate = loudnessOf(mean(aboveAbsolute)) - LOUDNESS_RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((meanSquare) => loudnessOf(meanSquare) > relativeGate);
  if (gated.length === 0) return Number.NEGATIVE_INFINITY;

  return loudnessOf(mean(gated));
}

/**
 * Requirement 24.7's window and interval for a sound-pack cue.
 *
 * 400 ms at 100 ms intervals — which is BS.1770-4's gating block at 75 % overlap, i.e.
 * exactly the block layout `integratedLoudnessLufs` already uses. Restated here under the
 * names Requirement 24.7 uses so a reader checking that clause finds its numbers, and so
 * `domain/sound-pack/bounds.ts` and this module cannot drift apart.
 */
export const SHORT_TERM_WINDOW_MS = LOUDNESS_BLOCK_MS;
export const SHORT_TERM_HOP_MS = LOUDNESS_BLOCK_MS * (1 - LOUDNESS_BLOCK_OVERLAP);

/**
 * Requirement 24.7's per-window loudness values, in window order.
 *
 * The same K-weighting and the same channel summation as the integrated measurement — one
 * weighting implementation in this layer, not two — and deliberately **ungated**. A gate
 * exists to exclude quiet blocks from a *mean*; 24.7 asks for the maximum of the window
 * values, and gating a maximum could only ever remove the answer.
 *
 * A buffer shorter than one window is measured as a single window over the whole buffer.
 * That is 24.7's own instruction — "오디오 길이가 400밀리초 미만인 큐는 전체 구간을 1개
 * 창으로 측정" — and it is the accommodation `blockMeanSquares` already makes, for the
 * reason stated there. It matters here far more than it does for `bgm`: most of the 78-cue
 * taxonomy is one-shots under 1.5 seconds and many are under 400 ms, so the short-buffer
 * path is the *normal* path for a sound pack rather than an edge case.
 */
export function shortTermLoudnessesLufs(
  audio: PcmAudio,
  windowMs: number = SHORT_TERM_WINDOW_MS,
  hopMs: number = SHORT_TERM_HOP_MS,
): readonly number[] {
  if (!isWellFormed(audio)) return [];
  return blockMeanSquares(audio, windowMs, hopMs).map(loudnessOf);
}

/**
 * Requirement 24.7's quantity: the largest per-window loudness, or `-Infinity`.
 *
 * The **maximum**, not the mean and not the integrated value. The distinction is the whole
 * content of the clause and is easy to lose: for a stationary signal the two agree, so a
 * test using one steady tone cannot tell them apart, and a cue with a loud transient and a
 * long quiet tail reads several LUFS louder under 24.7 than under Requirement 30.24. That
 * is the intended reading — a UI cue is judged by how loud it *lands*, since a click that
 * peaks at −14 LUFS is startling however quiet its decay makes the average.
 *
 * `-Infinity` for silence rather than a floor, by the rule `integratedLoudnessLufs`
 * follows: a floor would put a silent cue inside the −25…−21 LUFS band it cannot be in.
 */
export function maxShortTermLoudnessLufs(
  audio: PcmAudio,
  windowMs: number = SHORT_TERM_WINDOW_MS,
  hopMs: number = SHORT_TERM_HOP_MS,
): number {
  const values = shortTermLoudnessesLufs(audio, windowMs, hopMs);
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  return values.reduce((worst, value) => Math.max(worst, value), Number.NEGATIVE_INFINITY);
}
