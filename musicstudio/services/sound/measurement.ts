/**
 * The audio measurement port.
 *
 * Every number the loop criteria and the intensity ladder judge comes from here, and
 * nothing above this port knows how it was obtained. That matters for two reasons:
 *
 * 1. **Requirement 21's rules are testable without audio infrastructure.** The
 *    predicates in `domain/bgm/` take measurements; a test states a measurement.
 * 2. **The measurement is replaceable.** `in-process-measurement.ts` computes it in
 *    TypeScript from PCM the product layer already holds. Task 3.1's Python worker will
 *    compute the same quantities with `librosa`/`pyloudnorm` from a stored object,
 *    behind this same interface.
 *
 * **Integration point (task 3.1).** The worker implementation replaces
 * `createInProcessAudioMeasurement()` at the composition site and takes an object key
 * instead of a decoded buffer, so `MeasurementSubject` is a union rather than a
 * `PcmAudio`: a caller that already has samples passes them, and a caller that has only
 * a stored asset passes its locator. The in-process implementation supports the first
 * form and rejects the second, which keeps the seam honest instead of pretending it can
 * read storage.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { LoopMeasurement } from '../../domain/bgm/loop-seam';
import type { TailDecayMeasurement } from '../../domain/sfx/tail-decay';

/** What is to be measured: samples in hand, or an asset the DSP worker can open. */
export type MeasurementSubject =
  | { readonly kind: 'pcm'; readonly audio: PcmAudio }
  /** Task 3.1: an object the worker resolves. Rejected by the in-process measurer. */
  | { readonly kind: 'stored'; readonly objectKey: string };

export interface LoopMeasurementQuery {
  readonly subject: MeasurementSubject;
  /** Requirement 21.17 measures against the asset's recorded tempo. */
  readonly bpm: number;
  readonly timeSignature: number;
  /** Requirement 21.7's window. Defaults to `BGM_SEAM_WINDOW_MS`. */
  readonly seamWindowMs?: number;
  /** Requirement 21.16's window. Defaults to `BGM_EDGE_WINDOW_MS`. */
  readonly edgeWindowMs?: number;
}

export interface TailDecayQuery {
  readonly subject: MeasurementSubject;
  /** Requirement 22.15's window. Defaults to `SFX_TAIL_WINDOW_MS`. */
  readonly tailWindowMs?: number;
}

export interface AudioMeasurementPort {
  /** Requirements 21.7, 21.8, 21.16, 21.17 and the 21.15 loudness, in one pass. */
  measureLoop(query: LoopMeasurementQuery): Promise<LoopMeasurement>;
  /** Requirement 21.11's quantity on its own, for the non-loop variant path. */
  measureLoudnessLufs(subject: MeasurementSubject): Promise<number>;
  /** Requirements 21.10, 21.15: length, rate and channel count. */
  measureShape(subject: MeasurementSubject): Promise<AudioShape>;
  /**
   * Requirement 22.15: the tail peak and the overall peak, per channel.
   *
   * A separate call rather than two more fields on `measureLoop`, because a one-shot sound
   * effect has no loop point, no tempo and therefore no `LoopMeasurement` to belong to —
   * asking for one would mean supplying a BPM for audio that has none.
   */
  measureTailDecay(query: TailDecayQuery): Promise<TailDecayMeasurement>;
}

export interface AudioShape {
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export class MeasurementUnsupportedError extends Error {
  constructor(kind: MeasurementSubject['kind']) {
    super(`this measurement implementation cannot read a '${kind}' subject`);
    this.name = 'MeasurementUnsupportedError';
  }
}
