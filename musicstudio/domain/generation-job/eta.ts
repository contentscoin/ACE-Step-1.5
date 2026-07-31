/**
 * Expected completion time for a queued job (Requirements 5.1, 5.5).
 *
 * 5.5 names both inputs: the queue position and the average duration the target
 * engine reports. Neither is a guess made here — the position comes from the queue
 * port and the average from the engine's own statistics — so this module is only
 * the arithmetic that joins them, kept pure so the value is reproducible.
 *
 * `queuePosition` is 1-based, where 1 means "next to run". Position 1 therefore
 * waits for nothing and finishes one average duration from now; position n waits
 * for the n-1 jobs ahead of it first.
 */

/** Sentinel used when the engine has reported no average yet. */
export const UNKNOWN_AVERAGE_DURATION_MS = 0;

export interface EtaInput {
  /** 1-based position in the queue; 1 = next to run. */
  readonly queuePosition: number;
  /** Average job duration as reported by the target engine. */
  readonly averageDurationMs: number;
  readonly nowMs: number;
}

export interface EtaEstimate {
  /** Time expected to elapse before this job starts. */
  readonly queueWaitMs: number;
  readonly estimatedCompletionAtMs: number;
  /** The two inputs, echoed so a client can show *why* the estimate is what it is. */
  readonly basis: {
    readonly queuePosition: number;
    readonly averageDurationMs: number;
  };
}

/**
 * Requirement 5.5 estimate, or `null` when there is no basis for one.
 *
 * A missing or non-positive engine average yields `null` rather than "now": an
 * estimate of zero wait would be actively misleading, and 5.5 predicates the
 * estimate on the engine having reported an average.
 */
export function estimateCompletion(input: EtaInput): EtaEstimate | null {
  if (!Number.isFinite(input.averageDurationMs) || input.averageDurationMs <= 0) return null;
  if (!Number.isFinite(input.queuePosition) || input.queuePosition < 1) return null;

  const queueWaitMs = (Math.floor(input.queuePosition) - 1) * input.averageDurationMs;

  return {
    queueWaitMs,
    estimatedCompletionAtMs: input.nowMs + queueWaitMs + input.averageDurationMs,
    basis: {
      queuePosition: Math.floor(input.queuePosition),
      averageDurationMs: input.averageDurationMs,
    },
  };
}
