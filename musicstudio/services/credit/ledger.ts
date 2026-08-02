/**
 * Append-only store of credit ledger entries (Requirements 2.2, 2.4, 2.7, 2.8).
 *
 * The port has no update and no delete, mirroring `credit_ledger_entry` in
 * `db/migrations/0010_credit.sql`, which rejects both at the database level. A
 * refund is a new entry, never an edit of the charge.
 *
 * `appendUnique` is how double-charging and double-refunding are prevented: the
 * store refuses a second entry for the same `(jobId, entryType)` pair, which is
 * the unique index the migration declares. The service relies on that refusal
 * rather than on having checked first, so a retry that races with itself cannot
 * produce two charges.
 */

import {
  validateLedgerEntry,
  type CreditEntryType,
  type CreditLedgerEntry,
} from '../../domain/credit/ledger-entry';

export interface AppendOutcome {
  /** `false` when an entry for this `(jobId, entryType)` already existed. */
  readonly appended: boolean;
  readonly entry: CreditLedgerEntry;
}

export interface CreditLedgerStore {
  append(entry: CreditLedgerEntry): Promise<AppendOutcome>;
  entriesFor(accountId: string): Promise<readonly CreditLedgerEntry[]>;
  findByJob(jobId: string, entryType: CreditEntryType): Promise<CreditLedgerEntry | undefined>;
}

/**
 * In-process ledger.
 *
 * Used by the test suites and by a single-process development run. The
 * PostgreSQL-backed implementation wraps the same port over the table the
 * migration creates; it is not written here because the schema, not the client,
 * is what task 1.4 owns.
 */
export function createInMemoryCreditLedger(): CreditLedgerStore {
  const byAccount = new Map<string, CreditLedgerEntry[]>();
  const jobKeys = new Set<string>();

  const jobKey = (jobId: string, entryType: CreditEntryType): string => `${entryType}:${jobId}`;

  return {
    async append(entry) {
      const violations = validateLedgerEntry(entry);
      if (violations.length > 0) {
        throw new Error(`invalid credit ledger entry: ${violations.join(', ')}`);
      }

      if (entry.jobId !== null) {
        const key = jobKey(entry.jobId, entry.entryType);
        if (jobKeys.has(key)) {
          const existing = (byAccount.get(entry.accountId) ?? []).find(
            (candidate) => candidate.jobId === entry.jobId && candidate.entryType === entry.entryType,
          );
          return { appended: false, entry: existing ?? entry };
        }
        jobKeys.add(key);
      }

      const entries = byAccount.get(entry.accountId) ?? [];
      entries.push(entry);
      byAccount.set(entry.accountId, entries);
      return { appended: true, entry };
    },

    async entriesFor(accountId) {
      return [...(byAccount.get(accountId) ?? [])];
    },

    async findByJob(jobId, entryType) {
      for (const entries of byAccount.values()) {
        const found = entries.find(
          (entry) => entry.jobId === jobId && entry.entryType === entryType,
        );
        if (found !== undefined) return found;
      }
      return undefined;
    },
  };
}
