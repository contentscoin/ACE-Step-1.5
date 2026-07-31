/**
 * Onset detection on produced audio (Requirement 23.8; design §5.4).
 *
 * 23.8 defines the measurement exactly: "산출 오디오의 온셋은 5밀리초 프레임 단위 단기 RMS가
 * 직전 50밀리초 평균 RMS보다 6.0데시벨 이상 큰 최초 프레임의 시작 시각으로 측정한다".
 *
 * Built on `domain/audio/level.ts`, not on a new RMS implementation: the same `rms` the loop
 * seam and the one-shot tail are measured with, so a change to the arithmetic cannot make
 * two rules disagree about how loud a window is.
 *
 * ### The one interpretation this module makes
 *
 * 23.8's definition says "**최초** 프레임" — *the first* frame — which read strictly would
 * mean one onset per asset. But the same sentence then requires, for each confident visual
 * event, that "±80밀리초 구간 안에 산출 오디오의 온셋이 **1개 이상** 존재" — onsets, plural,
 * distributed through the audio. A single onset cannot be within 80 ms of two events 3
 * seconds apart, so the 90 % alignment rate would be unsatisfiable for any clip with two
 * events, and 23.15's timeline of many events would be pointless.
 *
 * So "최초" is read as **the first frame of each qualifying run**: a frame whose rise clears
 * the threshold and whose predecessor's did not. That is a rising-edge detector, and it is
 * the only reading under which the rest of 23.8 is satisfiable. Without it, a sustained
 * crescendo would register an onset every 5 ms — hundreds per second, which would make the
 * alignment rate trivially 100 % and the check worthless in the other direction.
 *
 * **This is an ambiguity in Requirement 23.8 and it is reported as one**; the reading is
 * documented rather than silently chosen.
 *
 * ### The start of the audio
 *
 * A frame with no full 50 ms of history compares against the history it has. Frame 0 has
 * none at all, so its reference is silence — meaning a non-silent first frame *is* an onset,
 * at 0 ms. That is both the musically correct answer (audio beginning from nothing has
 * started) and the necessary one: foley for an impact on the first video frame is the
 * commonest case there is, and a detector blind to the first 50 ms could never align it.
 *
 * Silence handled explicitly rather than through dB arithmetic, for the reason
 * `amplitudeDifferenceDb` documents: `-Infinity − (−Infinity)` is `NaN`, and a `NaN`
 * compared against any threshold is false, so two silent frames would read as "no onset"
 * only by accident and a silent-to-loud transition would read as "no onset" wrongly.
 */

import { amplitudeToDb, rms } from '../audio/level';
import { type PcmAudio, windowSampleCount } from '../audio/pcm';

import { V2A_ONSET_FRAME_MS, V2A_ONSET_LOOKBACK_MS } from './bounds';

export interface OnsetDetectionOptions {
  /** Requirement 23.8's rise, in dB. From the Quality_Threshold_Set; never a literal. */
  readonly riseDb: number;
  /** Requirement 23.8's 5 ms. A constant; see `domain/v2a/bounds.ts`. */
  readonly frameMs?: number;
  /** Requirement 23.8's 50 ms. */
  readonly lookbackMs?: number;
}

export interface DetectedOnset {
  /** Requirement 23.8: the *start* time of the qualifying frame, milliseconds. */
  readonly timeMs: number;
  /** 0-based frame index, so a test can locate it without re-deriving the frame length. */
  readonly frameIndex: number;
  /** How far the frame rose above its preceding average, dB. `Infinity` from silence. */
  readonly riseDb: number;
}

/**
 * Requirement 23.8's onsets, in ascending time order.
 *
 * Monaural sum across channels rather than per channel: an onset is an event in the *sound*,
 * and a transient panned hard right is no less an onset for being quiet on the left. Taking
 * the maximum across channels per frame — rather than the mean — is what makes that true,
 * since a mean would halve a hard-panned hit and could push it under the threshold.
 */
export function detectOnsets(
  audio: PcmAudio,
  options: OnsetDetectionOptions,
): readonly DetectedOnset[] {
  const frameMs = options.frameMs ?? V2A_ONSET_FRAME_MS;
  const lookbackMs = options.lookbackMs ?? V2A_ONSET_LOOKBACK_MS;
  const energies = frameEnergies(audio, frameMs);
  const lookbackFrames = Math.max(1, Math.round(lookbackMs / frameMs));

  const onsets: DetectedOnset[] = [];
  let previousQualified = false;

  for (let frame = 0; frame < energies.length; frame += 1) {
    const rise = riseAt(energies, frame, lookbackFrames);
    const qualified = rise >= options.riseDb;

    // The rising edge, not every qualifying frame. See the module comment.
    if (qualified && !previousQualified) {
      onsets.push({ timeMs: frame * frameMs, frameIndex: frame, riseDb: rise });
    }
    previousQualified = qualified;
  }

  return onsets;
}

/** Just the times, which is all the alignment check needs. */
export function onsetTimesMs(
  audio: PcmAudio,
  options: OnsetDetectionOptions,
): readonly number[] {
  return detectOnsets(audio, options).map((onset) => onset.timeMs);
}

/**
 * Per-frame short-term level: the loudest channel's RMS over each 5 ms frame.
 *
 * Exported because it is the quantity 23.8 is written in terms of, and a test that can read
 * it can check the detector against an independently computed expectation rather than
 * against itself.
 */
export function frameEnergies(
  audio: PcmAudio,
  frameMs: number = V2A_ONSET_FRAME_MS,
): readonly number[] {
  if (audio.sampleRate <= 0 || audio.channels.length === 0) return [];
  const frameSamples = windowSampleCount(audio.sampleRate, frameMs);
  const frames = Math.floor((audio.channels[0]?.length ?? 0) / frameSamples);

  const energies: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    let loudest = 0;
    for (const channel of audio.channels) {
      const level = rms(channel, frame * frameSamples, frameSamples);
      if (level > loudest) loudest = level;
    }
    energies.push(loudest);
  }
  return energies;
}

/**
 * How far frame `frame` rose above the average of the preceding `lookbackFrames`.
 *
 * `Infinity` when the history is silent and the frame is not — the honest answer for a
 * transient out of nothing, and the one that makes 23.8 detect it. `0` when both are silent,
 * so silence never reads as an onset. Frames before the full history is available use what
 * there is; frame 0 uses silence.
 */
export function riseAt(
  energies: readonly number[],
  frame: number,
  lookbackFrames: number,
): number {
  const current = energies[frame] ?? 0;
  const from = Math.max(0, frame - lookbackFrames);

  let sum = 0;
  for (let index = from; index < frame; index += 1) sum += energies[index] ?? 0;
  const preceding = frame > from ? sum / (frame - from) : 0;

  if (preceding <= 0) return current > 0 ? Number.POSITIVE_INFINITY : 0;
  if (current <= 0) return Number.NEGATIVE_INFINITY;
  return amplitudeToDb(current) - amplitudeToDb(preceding);
}
