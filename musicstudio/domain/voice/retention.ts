/**
 * Requirement 26.14 — a Voice_Consent_Record is immutable and retained for five
 * years past the target Voice_Profile's deletion.
 *
 * Modelled on `domain/audit-log/partition.ts`, deliberately: that module already
 * settled how this product layer expresses a retention floor — a constant, an
 * `assert…` that treats a shorter value as a programming error rather than a setting,
 * and a `CREATE FUNCTION` in the migration that raises on the same threshold. Copying
 * the shape means the SQL side needs no new idea and the parity test can check both
 * with the same technique.
 *
 * The clock origin is the *profile deletion* instant, not the submission instant. A
 * record for a live profile therefore never becomes prunable, which is the correct
 * reading of "삭제 시각으로부터 5년간" and also the safe one.
 */

import {
  CONSENT_RECORD_MIN_RETENTION_DAYS,
  CONSENT_RECORD_MIN_RETENTION_MS,
} from './windows';

export { CONSENT_RECORD_MIN_RETENTION_DAYS, CONSENT_RECORD_MIN_RETENTION_MS };

export interface ConsentRetentionSubject {
  /** `null` while the target profile still exists. */
  readonly profileDeletedAtMs: number | null;
}

/** The instant a record becomes eligible for deletion, or `null` if never. */
export function retentionFloorMs(subject: ConsentRetentionSubject): number | null {
  return subject.profileDeletedAtMs === null
    ? null
    : subject.profileDeletedAtMs + CONSENT_RECORD_MIN_RETENTION_MS;
}

/**
 * Whether a record may be deleted at `nowMs`.
 *
 * False while the profile lives, and false until the full window has passed. There is
 * no path that returns true early — which is the point of putting the rule here
 * instead of in a query someone might tighten by hand.
 */
export function isConsentRecordPrunable(
  subject: ConsentRetentionSubject,
  nowMs: number,
  retainDays: number = CONSENT_RECORD_MIN_RETENTION_DAYS,
): boolean {
  assertConsentRetentionDays(retainDays);
  if (subject.profileDeletedAtMs === null) return false;
  return nowMs >= subject.profileDeletedAtMs + retainDays * 86_400_000;
}

export function assertConsentRetentionDays(retainDays: number): void {
  if (!Number.isFinite(retainDays) || retainDays < CONSENT_RECORD_MIN_RETENTION_DAYS) {
    throw new RangeError(
      `Voice_Consent_Record retention must be at least ${CONSENT_RECORD_MIN_RETENTION_DAYS} ` +
        `days past profile deletion (Requirement 26.14), received ${retainDays}`,
    );
  }
}
