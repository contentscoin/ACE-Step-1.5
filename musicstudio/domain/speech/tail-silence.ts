/**
 * The trailing silence of a dialogue asset (Requirement 25.19).
 *
 * "합성된 오디오의 마지막 표본부터 역방향으로 측정한 -60dBFS 이하 연속 구간의 길이를 50밀리초
 * 이상 200밀리초 이하 범위로 조정한다".
 *
 * Three parts, and only the middle one is a judgement:
 *
 * 1. **Measure** — how long the run of samples at or below the floor is, counted backwards
 *    from the last sample. Done here, on PCM, so no port is needed for a quantity the product
 *    layer can compute from samples it already holds.
 * 2. **Judge** — whether the measured run is inside the window. The floor and the window are
 *    Quality_Threshold_Set members (`domain/quality/speech-thresholds.ts`), so the numbers
 *    Requirement 25.19 quotes are initial values rather than constants.
 * 3. **Adjust** — 25.19 says 조정한다, not 거부한다. A short tail is padded with silence and a
 *    long one is trimmed. **There is no failure path and no refund**, which is the substantive
 *    difference between this criterion and Requirements 22.14/22.15: those state invariants
 *    about what may be stored, and 25.19 states an operation to perform before storing.
 *
 * ### Why the target is the midpoint of the window
 *
 * Padding to exactly 50 ms would leave every asset on the boundary, so a later re-measurement
 * at a different frame rounding could report 49 ms and call the asset non-compliant. Trimming
 * to exactly 200 ms has the same problem from the other side. So both directions move to the
 * midpoint of the window, which is the only choice that is stable under re-measurement — and
 * that makes the adjustment **idempotent**: adjusting an already-adjusted asset changes
 * nothing, because the midpoint is inside the window.
 *
 * ### Silence is per-frame, not per-channel
 *
 * A frame counts as silent when *every* channel is at or below the floor. A tail where one
 * channel has decayed and the other has not is not silence, and treating channels
 * independently would let a stereo asset be trimmed into the middle of a word on one side.
 */

import { amplitudeToDb, dbToAmplitude } from '../audio/level';
import { channelCount, frameCount, type PcmAudio } from '../audio/pcm';
import type { DialogueTailSilenceThresholds } from '../quality/speech-thresholds';

export interface TailSilenceMeasurement {
  /** Length of the trailing run at or below the floor, in milliseconds. */
  readonly trailingSilenceMs: number;
  /** Peak level of the trailing run, in dBFS. `-Infinity` for true silence. */
  readonly trailingPeakDbfs: number;
  readonly durationMs: number;
  readonly sampleRate: number;
}

/**
 * Requirement 25.19's measurement, backwards from the last sample.
 *
 * The run stops at the first frame above the floor. A wholly silent buffer therefore measures
 * as its own length, which is the honest answer — and the adjustment below will trim it to the
 * window like any other over-long tail.
 */
export function measureTailSilence(
  audio: PcmAudio,
  silenceFloorDbfs: number,
): TailSilenceMeasurement {
  const frames = frameCount(audio);
  const sampleRate = audio.sampleRate;
  const floor = dbToAmplitude(silenceFloorDbfs);
  const channels = channelCount(audio);

  let silentFrames = 0;
  let peak = 0;
  for (let index = frames - 1; index >= 0; index -= 1) {
    let frameMax = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const magnitude = Math.abs(audio.channels[channel]?.[index] ?? 0);
      if (magnitude > frameMax) frameMax = magnitude;
    }
    if (frameMax > floor) break;
    if (frameMax > peak) peak = frameMax;
    silentFrames += 1;
  }

  return {
    trailingSilenceMs: sampleRate > 0 ? (silentFrames * 1000) / sampleRate : 0,
    trailingPeakDbfs: amplitudeToDb(peak),
    durationMs: sampleRate > 0 ? (frames * 1000) / sampleRate : 0,
    sampleRate,
  };
}

export interface TailSilenceVerdict {
  /** True when the measured run already lies inside the window. */
  readonly satisfied: boolean;
  readonly measuredMs: number;
  readonly targetMs: number;
  /** Milliseconds to add (positive) or remove (negative). Zero when satisfied. */
  readonly adjustmentMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** Requirement 34.6: the set version this verdict was taken against. */
  readonly qualityThresholdSetVersion: number;
}

/** Requirement 25.19's judgement plus the adjustment it implies. */
export function evaluateTailSilence(
  measurement: TailSilenceMeasurement,
  thresholds: DialogueTailSilenceThresholds,
): TailSilenceVerdict {
  const { tailSilenceMinMs: minMs, tailSilenceMaxMs: maxMs } = thresholds;
  const satisfied =
    measurement.trailingSilenceMs >= minMs && measurement.trailingSilenceMs <= maxMs;
  // The midpoint, for the stability reason in the module comment.
  const targetMs = satisfied ? measurement.trailingSilenceMs : (minMs + maxMs) / 2;

  return {
    satisfied,
    measuredMs: measurement.trailingSilenceMs,
    targetMs,
    adjustmentMs: satisfied ? 0 : targetMs - measurement.trailingSilenceMs,
    minMs,
    maxMs,
    qualityThresholdSetVersion: thresholds.version,
  };
}

/**
 * Requirement 25.19's 조정: pad or trim the tail so the silent run reaches `targetMs`.
 *
 * Pure. A trim never cuts into non-silent audio, because the run being shortened is silence by
 * definition; a pad appends zeros, which is silence at any floor. Both make the buffer's own
 * length change, which is why the caller re-measures the joined duration afterwards rather
 * than reusing the pre-adjustment number in 25.16's total.
 */
export function adjustTailSilence(audio: PcmAudio, verdict: TailSilenceVerdict): PcmAudio {
  if (verdict.adjustmentMs === 0) return audio;

  const frames = frameCount(audio);
  const delta = Math.round((verdict.adjustmentMs * audio.sampleRate) / 1000);
  if (delta === 0) return audio;

  if (delta > 0) {
    return {
      sampleRate: audio.sampleRate,
      channels: audio.channels.map((channel) => {
        const padded = new Float32Array(frames + delta);
        padded.set(channel, 0);
        return padded;
      }),
    };
  }

  // Never trim past the measured silent run, and never below one frame: an asset of nothing at
  // all would break 25.17's `end ≤ total` for its own last line.
  const silentFrames = Math.round((verdict.measuredMs * audio.sampleRate) / 1000);
  const removable = Math.min(-delta, Math.max(0, silentFrames), Math.max(0, frames - 1));
  if (removable === 0) return audio;

  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((channel) => Float32Array.from(channel.subarray(0, frames - removable))),
  };
}
