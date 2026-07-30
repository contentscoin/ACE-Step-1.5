/**
 * Monthly partition arithmetic and retention for the audit log (design §4.4).
 *
 * Pure counterpart of `audit_log_ensure_partition` and
 * `audit_log_prunable_partitions` in `db/migrations/0008_audit_log.sql`: same
 * names, same half-open bounds, same 365-day retention floor.
 */

/** Retention floor from design §4.4. Nothing may prune below this. */
export const AUDIT_LOG_MIN_RETENTION_DAYS = 365;

export const AUDIT_LOG_TABLE = 'audit_log';

const MS_PER_DAY = 86_400_000;

export interface MonthlyPartition {
  /** `audit_log_YYYY_MM`. */
  readonly name: string;
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  readonly fromInclusive: string;
  /** Exclusive upper bound, `YYYY-MM-DD`. */
  readonly toExclusive: string;
}

function utcMonthStart(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
}

function addMonths(monthStart: Date, months: number): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + months, 1));
}

function isoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

export function partitionName(instant: Date): string {
  const month = utcMonthStart(instant);
  return `${AUDIT_LOG_TABLE}_${month.getUTCFullYear()}_${pad2(month.getUTCMonth() + 1)}`;
}

/** The partition that must exist for a row stamped `instant`. */
export function partitionFor(instant: Date): MonthlyPartition {
  const from = utcMonthStart(instant);
  return {
    name: partitionName(from),
    fromInclusive: isoDate(from),
    toExclusive: isoDate(addMonths(from, 1)),
  };
}

/** `monthCount` consecutive partitions starting at the month containing `from`. */
export function partitionsFrom(from: Date, monthCount: number): MonthlyPartition[] {
  if (!Number.isInteger(monthCount) || monthCount < 1) {
    throw new RangeError(`monthCount must be a positive integer, received ${monthCount}`);
  }

  const start = utcMonthStart(from);
  return Array.from({ length: monthCount }, (_unused, offset) =>
    partitionFor(addMonths(start, offset)),
  );
}

export function containsInstant(partition: MonthlyPartition, instant: Date): boolean {
  const at = instant.getTime();
  return (
    at >= Date.parse(`${partition.fromInclusive}T00:00:00.000Z`) &&
    at < Date.parse(`${partition.toExclusive}T00:00:00.000Z`)
  );
}

/**
 * A partition may be pruned only once its whole range is older than the
 * retention window. `retainDays` below the design §4.4 floor is a programming
 * error, not a configuration choice.
 */
export function isPrunable(
  partition: MonthlyPartition,
  now: Date,
  retainDays: number = AUDIT_LOG_MIN_RETENTION_DAYS,
): boolean {
  assertRetentionDays(retainDays);
  const cutoff = now.getTime() - retainDays * MS_PER_DAY;
  return Date.parse(`${partition.toExclusive}T00:00:00.000Z`) <= cutoff;
}

export function assertRetentionDays(retainDays: number): void {
  if (!Number.isFinite(retainDays) || retainDays < AUDIT_LOG_MIN_RETENTION_DAYS) {
    throw new RangeError(
      `audit log retention must be at least ${AUDIT_LOG_MIN_RETENTION_DAYS} days ` +
        `(design §4.4), received ${retainDays}`,
    );
  }
}

export function prunablePartitions(
  partitions: readonly MonthlyPartition[],
  now: Date,
  retainDays: number = AUDIT_LOG_MIN_RETENTION_DAYS,
): MonthlyPartition[] {
  return partitions.filter((partition) => isPrunable(partition, now, retainDays));
}
