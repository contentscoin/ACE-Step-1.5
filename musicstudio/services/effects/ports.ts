/**
 * The seam between `Effects_Service` and the DSP worker (design §2.3, §5.5).
 *
 * The audio processing itself lives in Python — `dsp/src/musicstudio_dsp/effects.py`
 * over `pedalboard` — and is reached through a Celery task. That crossing is declared
 * here as an interface so the product-layer rules of Requirement 29 can be tested
 * without a broker, in the same way `services/sound/sfx-ports.ts` declares the
 * generation seam.
 *
 * ### What the port promises, and why each promise is on this side of the seam
 *
 * `EffectProcessingPort.process` receives a chain that has **already been validated**
 * against Requirements 29.9, 29.10 and 29.13. Validation is deliberately duplicated in
 * the worker rather than trusted (see `effects.py`), but it happens here *first* so that
 * a bad request is refused before credits are spent and before a task is queued — which
 * is what makes 29.10's synchronous "위반된 파라미터 이름과 허용 범위" response possible
 * at all. A worker-only check would answer minutes later, through a job failure.
 *
 * The reported result carries `sampleRate`, `channels` and `frameCount` rather than only
 * a duration, because Requirement 29.29's reproducibility invariant is stated over all
 * three plus the samples themselves. A duration in milliseconds cannot distinguish
 * 48 000 frames at 48 kHz from 44 100 at 44.1 kHz, and 29.29 requires both to match.
 */

import type { EffectChain } from '../../domain/effects';

/** Where the audio to process lives. Mirrors `MeasurementSubject`'s stored arm. */
export interface EffectProcessingSubject {
  readonly objectKey: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameCount: number;
}

export interface EffectProcessingRequest {
  readonly subject: EffectProcessingSubject;
  readonly chain: EffectChain;
  /**
   * Requirement 29.28: a preview is not stored.
   *
   * The flag travels to the worker rather than being handled purely here, because the
   * worker decides whether to write the processed audio to storage or stream it back.
   */
  readonly preview: boolean;
}

export interface EffectProcessingResult {
  /** Absent for a preview (Requirement 29.28). */
  readonly objectKey: string | null;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameCount: number;
  readonly durationMs: number;
  /**
   * Requirement 29.32: whether the tail was cut at the 10-second allowance.
   *
   * Reported rather than inferred, so the invariant can be asserted against what the
   * worker actually did instead of against a recomputation of what it should have done.
   */
  readonly tailTruncated: boolean;
}

export interface EffectProcessingPort {
  process(request: EffectProcessingRequest): Promise<EffectProcessingResult>;
}
