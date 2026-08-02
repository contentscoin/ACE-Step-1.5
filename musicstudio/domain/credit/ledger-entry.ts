/**
 * Credit ledger entry (Requirements 2.2, 2.4, 2.8; design §2.4, §4.4).
 *
 * Every credit movement is one append-only entry with a *signed* amount, so the
 * balance is a fold and the history is never rewritten:
 *
 * - `initial_grant`  (+) Requirement 2.1, once per account
 * - `cycle_renewal`  (+) Requirement 2.8, and the marker that starts a new
 *                        billing period, which is what "zeroes the monthly
 *                        aggregate" without deleting anything
 * - `charge`         (−) Requirements 2.2, 2.10, 2.12, 2.13
 * - `refund`         (+) Requirement 2.4, at most one per charged job
 *
 * `db/migrations/0010_credit.sql` is the durable form of exactly this shape; the
 * arithmetic below is stated here once and the SQL views wrap it.
 */

import type { AssetKind } from '../asset-kind';

export const CREDIT_ENTRY_TYPES = [
  'initial_grant',
  'cycle_renewal',
  'charge',
  'refund',
] as const;

export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

/** Entry types that add credits, and therefore must carry a positive amount. */
export const CREDIT_GRANT_TYPES: readonly CreditEntryType[] = [
  'initial_grant',
  'cycle_renewal',
  'refund',
];

/** Entry types that open a new billing period (Requirement 2.8). */
export const PERIOD_OPENING_TYPES: readonly CreditEntryType[] = ['initial_grant', 'cycle_renewal'];

/** What a charge paid for; Requirement 2.12 and 2.13 are their own kinds. */
export const CHARGE_KINDS = ['generation', 'mixdown', 'sound_pack'] as const;

export type ChargeKind = (typeof CHARGE_KINDS)[number];

export interface CreditLedgerEntry {
  readonly entryId: string;
  readonly accountId: string;
  readonly entryType: CreditEntryType;
  /** Signed: negative for `charge`, positive otherwise. */
  readonly amount: number;
  /** Present on `charge` and `refund`; the Generation_Job this belongs to. */
  readonly jobId: string | null;
  readonly chargeKind: ChargeKind | null;
  readonly assetKind: AssetKind | null;
  readonly engineId: string | null;
  readonly durationMs: number | null;
  /** Number of outputs the charge covered — 78 for a Sound_Pack (2.13). */
  readonly outputCount: number | null;
  readonly reason: string;
  readonly occurredAtMs: number;
}

export function isCreditEntryType(value: unknown): value is CreditEntryType {
  return typeof value === 'string' && (CREDIT_ENTRY_TYPES as readonly string[]).includes(value);
}

/** Balance is the fold of the ledger; nothing else may define it. */
export function balanceOf(entries: readonly CreditLedgerEntry[]): number {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

/**
 * Start of the billing period in force (Requirement 2.8).
 *
 * The newest period-opening entry marks it. Before any grant exists there is no
 * period, and callers treat that as "everything so far".
 */
export function currentPeriodStartMs(entries: readonly CreditLedgerEntry[]): number {
  return entries
    .filter((entry) => PERIOD_OPENING_TYPES.includes(entry.entryType))
    .reduce((latest, entry) => Math.max(latest, entry.occurredAtMs), 0);
}

export function entriesSince(
  entries: readonly CreditLedgerEntry[],
  fromInclusiveMs: number,
): readonly CreditLedgerEntry[] {
  return entries.filter((entry) => entry.occurredAtMs >= fromInclusiveMs);
}

export function chargeFor(
  entries: readonly CreditLedgerEntry[],
  jobId: string,
): CreditLedgerEntry | undefined {
  return entries.find((entry) => entry.entryType === 'charge' && entry.jobId === jobId);
}

export function refundFor(
  entries: readonly CreditLedgerEntry[],
  jobId: string,
): CreditLedgerEntry | undefined {
  return entries.find((entry) => entry.entryType === 'refund' && entry.jobId === jobId);
}

export type LedgerEntryViolation =
  | 'amount_not_integer'
  | 'amount_sign_mismatch'
  | 'charge_requires_job_id'
  | 'refund_requires_job_id'
  | 'grant_must_not_reference_job';

/** Shape rules mirrored by the CHECK constraints in 0010_credit.sql. */
export function validateLedgerEntry(entry: CreditLedgerEntry): LedgerEntryViolation[] {
  const violations: LedgerEntryViolation[] = [];

  if (!Number.isInteger(entry.amount)) violations.push('amount_not_integer');

  const shouldBePositive = CREDIT_GRANT_TYPES.includes(entry.entryType);
  if (shouldBePositive ? entry.amount < 0 : entry.amount > 0) {
    violations.push('amount_sign_mismatch');
  }

  if (entry.entryType === 'charge' && entry.jobId === null) {
    violations.push('charge_requires_job_id');
  }
  if (entry.entryType === 'refund' && entry.jobId === null) {
    violations.push('refund_requires_job_id');
  }
  if (PERIOD_OPENING_TYPES.includes(entry.entryType) && entry.jobId !== null) {
    violations.push('grant_must_not_reference_job');
  }

  return violations;
}
