/**
 * The stored Generation_Job (Requirements 5.1, 6.4).
 *
 * Two fields carry a requirement on their own:
 *
 * - `engineJobId` is the identifier Requirement 5.1 says to store. It is `null`
 *   only between accepting the request and the engine answering the submit.
 * - `input` is the whole normalised request minus its per-attempt `requestId`,
 *   which is precisely what Requirement 6.4 needs to build a retry with
 *   "identical input parameters". Storing the request object rather than a handful
 *   of copied fields is what makes that identity checkable by comparing one value.
 */

import type { NormalizedGenerationRequest } from '../../adapters/normalized-generation';
import type { JobLifecycle } from '../../domain/generation-job/lifecycle';

/**
 * The reusable part of a submitted request.
 *
 * `requestId` is excluded because it identifies one attempt, not the intent; a
 * Requirement 6.4 retry is a new attempt at the same intent.
 */
export type GenerationJobInput = Omit<NormalizedGenerationRequest, 'requestId'>;

export interface GenerationJobRecord {
  readonly jobId: string;
  readonly accountId: string;
  readonly input: GenerationJobInput;
  /** Engine chosen by routing, which may differ from `input.engineId` (20.10). */
  readonly engineId: string;
  /** Requirement 5.1: the engine's own job identifier. */
  readonly engineJobId: string | null;
  readonly lifecycle: JobLifecycle;
  /** Start of the Requirement 5.8 budget. */
  readonly acceptedAtMs: number;
  readonly updatedAtMs: number;
  /** Credits debited for this job; the amount Requirements 5.7/5.8/6.3 refund. */
  readonly debitedAmount: number;
  /** Requirement 6.2: re-requests spent so far. */
  readonly attemptsMade: number;
  /** Requirement 6.5: consecutive failed contacts since the last good poll. */
  readonly unreachableStreak: number;
  readonly progressPercent: number | null;
  /** Requirement 6.4: the job this one retries, when it is a retry. */
  readonly retryOfJobId: string | null;
  /** Requirement 5.6: Audio_Asset identifiers created from the results. */
  readonly assetIds: readonly string[];
  /** Requirement 5.4: monotonically increasing per job, for ordered delivery. */
  readonly eventSequence: number;
}

export interface NewJobInput {
  readonly jobId: string;
  readonly accountId: string;
  readonly input: GenerationJobInput;
  readonly engineId: string;
  readonly acceptedAtMs: number;
  readonly debitedAmount: number;
  readonly retryOfJobId?: string | null;
}

export function createJobRecord(input: NewJobInput): GenerationJobRecord {
  return {
    jobId: input.jobId,
    accountId: input.accountId,
    input: input.input,
    engineId: input.engineId,
    engineJobId: null,
    lifecycle: { state: 'pending', failure: null },
    acceptedAtMs: input.acceptedAtMs,
    updatedAtMs: input.acceptedAtMs,
    debitedAmount: input.debitedAmount,
    attemptsMade: 0,
    unreachableStreak: 0,
    progressPercent: null,
    retryOfJobId: input.retryOfJobId ?? null,
    assetIds: [],
    eventSequence: 0,
  };
}

/**
 * Requirement 6.4: the request for a retry of `record`.
 *
 * A fresh `requestId` with an unchanged `input` — the retry is a new attempt at
 * the same intent, which is exactly the distinction `GenerationJobInput` encodes.
 */
export function retryRequestOf(
  record: GenerationJobRecord,
  requestId: string,
): NormalizedGenerationRequest {
  return { ...record.input, requestId };
}
