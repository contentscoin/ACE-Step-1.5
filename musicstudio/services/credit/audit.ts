/**
 * Audit_Log drafts for credit movements (Requirements 2.2, 2.4; design §4.4).
 *
 * Design §4.4 lists "크레딧 변동" first among the events that must be recorded,
 * and the event type already exists in `domain/audit-log/entry.ts`
 * (`credit_changed`), so this module only decides what the before/after values
 * are — it does not introduce a second audit vocabulary.
 *
 * The sink port is declared here rather than imported from
 * `adapters/registry/ports.ts`: a service must not depend on the adapter layer to
 * write an audit entry. It is structurally identical, so one recording fake
 * satisfies both.
 */

import type { AuditLogDraft } from '../../domain/audit-log/entry';
import type { CreditLedgerEntry } from '../../domain/credit/ledger-entry';

export interface CreditAuditSink {
  record(draft: AuditLogDraft): void;
}

export const noopCreditAuditSink: CreditAuditSink = {
  record: () => undefined,
};

/**
 * One draft per ledger entry.
 *
 * `beforeValue`/`afterValue` hold the balance either side of the movement, which
 * is what makes a credit dispute answerable from the audit log alone: the
 * `credit_changed` rows for an account reconstruct the balance history without
 * consulting Redis.
 */
export function creditAuditDraft(input: {
  readonly entry: CreditLedgerEntry;
  readonly balanceBefore: number;
  readonly balanceAfter: number;
}): AuditLogDraft {
  const { entry } = input;

  return {
    eventType: 'credit_changed',
    actorId: entry.accountId,
    targetId: entry.jobId,
    beforeValue: { balance: input.balanceBefore },
    afterValue: {
      balance: input.balanceAfter,
      change: entry.entryType,
      delta: entry.amount,
      reason: entry.reason,
      chargeKind: entry.chargeKind,
      assetKind: entry.assetKind,
      engineId: entry.engineId,
      durationMs: entry.durationMs,
      outputCount: entry.outputCount,
      entryId: entry.entryId,
    },
    eventTime: new Date(entry.occurredAtMs),
  };
}
