/**
 * Engine status code translation (Requirement 5.3; design §3.1).
 *
 * 5.3 fixes the table: 0 is running, 1 is success, 2 is failed. It lives here
 * rather than in `domain/generation-job/` so the wire values stay in one place —
 * `adapters/engine-job.ts`'s `ENGINE_JOB_STATE` — and the domain state machine
 * stays free of any engine vocabulary.
 *
 * Pure: a total function from an engine status to a lifecycle event.
 */

import { ENGINE_JOB_STATE, type EngineJobState, type EngineJobStatus } from '../../adapters/engine-job';
import { classifyEngineFailure } from '../../domain/generation-job/failure';
import type { GenerationJobState, JobLifecycleEvent } from '../../domain/generation-job/lifecycle';

/**
 * Requirement 5.3 as a lookup, exhaustive over `EngineJobState`.
 *
 * Exported so the criterion can be asserted directly, rather than only inferred
 * from the behaviour of the event mapping below.
 */
export const USER_VISIBLE_STATE_FOR_ENGINE_STATE: Readonly<
  Record<EngineJobState, GenerationJobState>
> = {
  [ENGINE_JOB_STATE.running]: 'running',
  [ENGINE_JOB_STATE.succeeded]: 'succeeded',
  [ENGINE_JOB_STATE.failed]: 'failed',
};

/** The lifecycle event one polled engine status implies. */
export function lifecycleEventFor(status: EngineJobStatus): JobLifecycleEvent {
  switch (status.state) {
    case ENGINE_JOB_STATE.running:
      return { kind: 'engine_running' };
    case ENGINE_JOB_STATE.succeeded:
      return { kind: 'engine_succeeded' };
    case ENGINE_JOB_STATE.failed:
      return {
        kind: 'engine_failed',
        // Requirement 6.1: the classification comes from what the engine said.
        failure: classifyEngineFailure(
          status.failureReason === undefined ? {} : { reason: status.failureReason },
        ),
      };
  }
}
