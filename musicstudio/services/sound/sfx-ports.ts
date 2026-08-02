/**
 * Narrow outbound ports of the SFX_Service.
 *
 * Same discipline as `bgm-ports.ts`: each is the seam to a service this task does not build,
 * stated in the shape Requirement 22 needs rather than waiting for that service to exist.
 *
 * - `SfxCandidatePort` answers "what did the engine actually produce for this variant".
 *   Requirements 22.14 and 22.15 have to inspect the audio *before* the asset is published —
 *   a one-shot that has not decayed must not be saved and then withdrawn — so this port sits
 *   between the engine result and completion, exactly where `BgmCandidatePort` sits.
 *   **Integration point (tasks 3.1, 5.1)**: `job-poller.ts` already fetches the engine's
 *   results in `completeJob()`; the composition that owns the DSP worker supplies those
 *   results here, and the quality verdict decides whether `applyJobEvent` then receives
 *   `engine_succeeded` or the rejection path below.
 *
 * - `SfxQualityRejectionPort` performs the fail-and-refund step for a variant whose audio
 *   misses 22.14 or 22.15. `job-quality-rejection.ts` implements it over `JobRuntime` — the
 *   same implementation Requirement 21.18 uses — which means the refund goes through the same
 *   `CreditRefundPort` as Requirements 5.7, 5.8, 6.3, 20.15 and 21.18. One refund path in the
 *   system, not two.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { JobFailure } from '../../domain/generation-job/failure';

import type { SfxQualityCriterion } from './sfx-result';

export interface SfxCandidateQuery {
  readonly jobId: string;
  readonly accountId: string;
  /** The seed this variant was submitted with, so the port can echo it back. */
  readonly seed: number;
}

/**
 * The engine's output for one variant.
 *
 * `alignmentScore` is the engine's raw number, not a normalised one: Requirement 22.7's
 * normalisation is the product layer's (`domain/sfx/alignment.ts`), and normalising at the
 * port would hide whether a score outside `[0, 1]` ever arrived. `null` means the engine
 * reported none, which is a scoreless candidate rather than a failure — see
 * `sfx-result.ts` for what it ranks as.
 */
export interface SfxCandidate {
  readonly jobId: string;
  readonly assetId: string;
  readonly audio: PcmAudio;
  /** Requirement 22.13: the seed the engine actually used. */
  readonly seed: number;
  /** Requirement 22.6, as reported. `null` when unreported. */
  readonly alignmentScore: number | null;
}

export type SfxCandidateOutcome =
  | { readonly kind: 'produced'; readonly candidate: SfxCandidate }
  /**
   * The engine did not produce audio at all.
   *
   * Distinct from a quality miss on purpose: Requirements 6.1–6.3 already own this case and
   * have already refunded it, so the SFX_Service must not refund it a second time. See
   * `sfx-service.ts`.
   */
  | { readonly kind: 'unproduced'; readonly failure: JobFailure };

export interface SfxCandidatePort {
  /** Resolves once the engine's audio for an accepted job is available. */
  awaitCandidate(query: SfxCandidateQuery): Promise<SfxCandidateOutcome>;
}

export interface SfxQualityRejection {
  readonly jobId: string;
  readonly accountId: string;
  /** Requirements 22.14, 22.15: the criteria this variant did not meet. */
  readonly unmet: readonly SfxQualityCriterion[];
}

export interface SfxQualityRejectionResult {
  /** Credits returned. 0 when the job was never charged or was already terminal. */
  readonly refundedAmount: number;
}

export interface SfxQualityRejectionPort {
  reject(rejection: SfxQualityRejection): Promise<SfxQualityRejectionResult>;
}
