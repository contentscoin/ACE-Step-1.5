/**
 * Narrow outbound ports of the BGM_Service.
 *
 * Same discipline as `services/generation/ports.ts` and `edit-ports.ts`: each is the
 * seam to a service this task does not build, stated in the shape Requirement 21 needs
 * rather than waiting for that service to exist.
 *
 * - `BgmCandidatePort` answers "what did the engine actually produce for this job".
 *   Requirement 21.18 has to inspect the audio *before* the job is allowed to succeed —
 *   a loop that fails its seam criteria must not be published and then withdrawn — so
 *   this port sits between the engine result and completion. **Integration point (tasks
 *   3.1, 5.1)**: `job-poller.ts` already fetches the engine's results in
 *   `completeJob()`; the composition that owns the DSP worker supplies those results
 *   here, and the loop verdict decides whether `applyJobEvent` then receives
 *   `engine_succeeded` or the `rejectForQuality` path below.
 *
 * - `BgmQualityRejectionPort` performs Requirement 21.18's terminal step: end the job
 *   as failed and return the whole debit. `job-quality-rejection.ts` implements it over
 *   `JobRuntime`, which means the refund goes through the same `CreditRefundPort` as
 *   Requirements 5.7, 5.8, 6.3 and 20.15 — one refund path in the system, not two.
 */

import type { JobFailure } from '../../domain/generation-job/failure';
import type { PcmAudio } from '../../domain/audio/pcm';
import type { LoopSeamCriterion } from '../../domain/bgm/loop-seam';

export interface BgmCandidateQuery {
  readonly jobId: string;
  readonly accountId: string;
}

/**
 * The engine's output for one attempt, with the metadata Requirement 21.15 records.
 *
 * The tempo fields are the engine's, not the request's. Requirement 4.7 lets the
 * engine choose whatever the caller left empty, and Requirements 21.13 and 21.17 both
 * judge against what it chose, so the candidate reports it.
 */
export interface BgmCandidate {
  readonly jobId: string;
  readonly assetId: string;
  readonly audio: PcmAudio;
  readonly bpm: number;
  readonly keyScale: string;
  readonly timeSignature: number;
  /** Requirement 19.3: the seed the engine used, for reproducibility. */
  readonly seed: number;
}

export type BgmCandidateOutcome =
  | { readonly kind: 'produced'; readonly candidate: BgmCandidate }
  /**
   * The engine did not produce audio at all.
   *
   * Distinct from a quality miss on purpose: Requirement 6.1–6.3 already own this case
   * and have already refunded, so Requirement 21.18's attempt counter must not advance
   * for it. See `bgm-service.ts`.
   */
  | { readonly kind: 'unproduced'; readonly failure: JobFailure };

export interface BgmCandidatePort {
  /** Resolves once the engine's audio for an accepted job is available. */
  awaitCandidate(query: BgmCandidateQuery): Promise<BgmCandidateOutcome>;
}

export interface BgmQualityRejection {
  readonly jobId: string;
  readonly accountId: string;
  /** Requirement 21.18: the criteria this attempt did not meet. */
  readonly unmet: readonly LoopSeamCriterion[];
}

export interface BgmQualityRejectionResult {
  /** Requirement 21.18: credits returned. 0 when the job was never charged. */
  readonly refundedAmount: number;
}

export interface BgmQualityRejectionPort {
  reject(rejection: BgmQualityRejection): Promise<BgmQualityRejectionResult>;
}
