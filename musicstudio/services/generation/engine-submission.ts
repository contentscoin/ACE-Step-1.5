/**
 * Submitting to an engine, with the Requirement 6.2 backoff (also 6.1, 6.3, 20.14,
 * 20.15).
 *
 * Each attempt goes through `callRemoteEngine`, so the Requirement 20.14 300-second
 * cap applies per attempt and is not reimplemented here. The retry *schedule*
 * comes from `domain/generation-job/retry-policy.ts`, so the three numbers of
 * Requirement 6.2 are stated once.
 *
 * One deliberate asymmetry: a rejected attempt is retried, a *timed-out* attempt is
 * not. A timeout means 300 of the job's 900 seconds (Requirement 5.8) are already
 * spent; two more attempts plus polling would not fit inside what remains, so
 * burning the budget on them would only delay the same failure. A timeout also
 * means `callRemoteEngine` has already performed the Requirement 20.15 refund —
 * hence `refundSettled`, which the caller passes on so the lifecycle transition
 * does not refund a second time.
 */

import type { EngineAdapter } from '../../adapters/engine-adapter';
import type { EngineJobHandle } from '../../adapters/engine-job';
import type { NormalizedGenerationRequest } from '../../adapters/normalized-generation';
import { callRemoteEngine, type RemoteCallContext } from '../../adapters/registry/remote-call';
import {
  classifyEngineFailure,
  jobFailure,
  retriesExhaustedFailure,
  type JobFailure,
} from '../../domain/generation-job/failure';
import {
  retryDelayMs,
  shouldRetryEngineRejection,
} from '../../domain/generation-job/retry-policy';

import type { JobRuntime } from './runtime';
import { sleepVia } from './scheduling';

export interface SubmissionAttempt {
  /** 1 for the original request, 2+ for re-requests. */
  readonly attempt: number;
  /** Delay observed before this attempt; 0 for the original. */
  readonly delayMs: number;
  readonly failure: JobFailure;
}

export type SubmissionOutcome =
  | {
      readonly kind: 'submitted';
      readonly handle: EngineJobHandle;
      /** Re-requests spent before success. */
      readonly attemptsMade: number;
      readonly attempts: readonly SubmissionAttempt[];
    }
  | {
      readonly kind: 'failed';
      readonly failure: JobFailure;
      readonly attemptsMade: number;
      readonly attempts: readonly SubmissionAttempt[];
      /** True when Requirement 20.15 already returned the credits. */
      readonly refundSettled: boolean;
    };

export async function submitWithRetry(
  runtime: JobRuntime,
  adapter: EngineAdapter,
  request: NormalizedGenerationRequest,
  context: RemoteCallContext,
): Promise<SubmissionOutcome> {
  const attempts: SubmissionAttempt[] = [];
  let attemptsMade = 0;
  let delayMs = 0;

  for (;;) {
    let thrown: unknown;
    const outcome = await callRemoteEngine(
      async () => {
        try {
          return await adapter.submit(request);
        } catch (error) {
          // Captured because `callRemoteEngine` flattens a rejection to its
          // message, and Requirement 6.2 keys on the HTTP status.
          thrown = error;
          throw error;
        }
      },
      context,
      { timeoutRunner: runtime.timeoutRunner, clock: runtime.clock, refunds: runtime.refunds },
    );

    if (outcome.kind === 'completed') {
      return { kind: 'submitted', handle: outcome.value, attemptsMade, attempts };
    }

    if (outcome.kind === 'timed_out') {
      return {
        kind: 'failed',
        failure: jobFailure('engine_error', 'engine_timeout', `budget ${String(outcome.record.budgetMs)} ms`),
        attemptsMade,
        attempts,
        refundSettled: true,
      };
    }

    const failure = classifyEngineFailure({
      ...statusPart(thrown),
      reason: outcome.reason,
    });
    attempts.push({ attempt: attemptsMade + 1, delayMs, failure });

    if (!shouldRetryEngineRejection(attemptsMade, failure)) {
      return {
        kind: 'failed',
        // Requirement 6.3: the *count* ran out, so the reason says so while the
        // Requirement 6.1 classification of the last attempt is preserved.
        failure: attemptsMade > 0 ? retriesExhaustedFailure(failure) : failure,
        attemptsMade,
        attempts,
        refundSettled: false,
      };
    }

    attemptsMade += 1;
    delayMs = retryDelayMs(attemptsMade);
    await sleepVia(runtime.scheduler, delayMs);
  }
}

/** Reads an HTTP status off a thrown value, in either of the two usual spellings. */
function statusPart(error: unknown): { readonly httpStatus?: number } {
  if (typeof error !== 'object' || error === null) return {};
  const bag = error as { statusCode?: unknown; status?: unknown };
  const value = typeof bag.statusCode === 'number' ? bag.statusCode : bag.status;
  return typeof value === 'number' ? { httpStatus: value } : {};
}
