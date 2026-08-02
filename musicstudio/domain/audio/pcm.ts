/**
 * Decoded PCM, in the one shape every measurement in this layer reads.
 *
 * De-interleaved (one array per channel) because every rule in Requirement 21 that
 * measures anything measures it "채널별로" — per channel. Interleaved frames would
 * make each of those a strided read, and the strides would be duplicated in every
 * predicate.
 *
 * Samples are nominal `[-1, 1]` floats, which is the internal representation design
 * §5.1 fixes (32-bit float internally, 24-bit only on export). Nothing here clamps:
 * an engine that returns an inter-sample overshoot must be *measurable*, and
 * Requirement 21.8 compares against the channel's own peak rather than against 1.0,
 * so an overshoot changes the reference rather than invalidating the check.
 *
 * Pure data plus arithmetic over it — no decoding, no file access. Turning a stored
 * object into this shape is task 3.1's (see `services/sound/measurement.ts`).
 */

export interface PcmAudio {
  readonly sampleRate: number;
  /** One array per channel; all channels have the same length. */
  readonly channels: readonly Float32Array[];
}

export function channelCount(audio: PcmAudio): number {
  return audio.channels.length;
}

/** Frames, i.e. samples per channel. Zero for an audio with no channels. */
export function frameCount(audio: PcmAudio): number {
  return audio.channels[0]?.length ?? 0;
}

export function durationMs(audio: PcmAudio): number {
  if (audio.sampleRate <= 0) return 0;
  return (frameCount(audio) * 1000) / audio.sampleRate;
}

/**
 * Samples in a window of `ms` at `sampleRate`, at least 1.
 *
 * Rounded rather than truncated so a 10 ms window at 44 100 Hz is 441 samples and
 * not 440: Requirement 21.7 fixes the window in milliseconds and measures "저장된
 * 샘플레이트에서", so the sample count is derived from the stored rate every time
 * rather than assumed to be the 48 kHz of design §5.1.
 */
export function windowSampleCount(sampleRate: number, ms: number): number {
  return Math.max(1, Math.round((sampleRate * ms) / 1000));
}

/** True when every channel is the same length and there is at least one sample. */
export function isWellFormed(audio: PcmAudio): boolean {
  const frames = frameCount(audio);
  if (frames < 1 || audio.channels.length < 1) return false;
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) return false;
  return audio.channels.every((channel) => channel.length === frames);
}
