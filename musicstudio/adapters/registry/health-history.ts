/**
 * Health-check history retention (Requirement 20.7).
 *
 * 20.7 states two independent floors: at least the 100 most recent checks, and
 * at least 24 hours of them. Pruning therefore drops a record only when it is
 * *both* outside the newest 100 and older than 24 hours — satisfying either
 * floor alone would violate the other at some check rate.
 */

export const HEALTH_HISTORY_MIN_ENTRIES = 100;
export const HEALTH_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type HealthCheckOutcome = 'success' | 'failure';

export interface HealthCheckRecord {
  /** Millisecond precision, as Requirement 20.7 requires. */
  readonly checkedAtMs: number;
  readonly outcome: HealthCheckOutcome;
  readonly latencyMs: number;
  /** Set when the check was cut off by the 10-second budget. */
  readonly timedOut?: boolean;
  readonly detail?: string;
}

export interface HealthHistory {
  /** Oldest first. */
  readonly records: readonly HealthCheckRecord[];
  readonly latest: HealthCheckRecord | null;
  append(record: HealthCheckRecord): HealthHistory;
}

export function createHealthHistory(records: readonly HealthCheckRecord[] = []): HealthHistory {
  const ordered = [...records].sort((a, b) => a.checkedAtMs - b.checkedAtMs);

  return {
    records: ordered,
    latest: ordered.length === 0 ? null : (ordered[ordered.length - 1] ?? null),
    append(record) {
      return createHealthHistory(prune([...ordered, record], record.checkedAtMs));
    },
  };
}

/**
 * Keeps every record within the retention window, and never fewer than the
 * newest `HEALTH_HISTORY_MIN_ENTRIES`.
 */
function prune(records: readonly HealthCheckRecord[], nowMs: number): HealthCheckRecord[] {
  if (records.length <= HEALTH_HISTORY_MIN_ENTRIES) return [...records];

  const cutoffMs = nowMs - HEALTH_HISTORY_RETENTION_MS;
  const withinWindow = records.filter((record) => record.checkedAtMs >= cutoffMs);
  if (withinWindow.length >= HEALTH_HISTORY_MIN_ENTRIES) return withinWindow;

  return records.slice(records.length - HEALTH_HISTORY_MIN_ENTRIES);
}

/** Records at or after `nowMs - 24h`; used to assert the retention window. */
export function recordsWithinRetentionWindow(
  history: HealthHistory,
  nowMs: number,
): readonly HealthCheckRecord[] {
  const cutoffMs = nowMs - HEALTH_HISTORY_RETENTION_MS;
  return history.records.filter((record) => record.checkedAtMs >= cutoffMs);
}
