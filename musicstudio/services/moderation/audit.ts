/**
 * Requirement 16.7 — record every policy block in the Audit_Log.
 *
 * Reuses the existing `policy_blocked` event type from `domain/audit-log/entry.ts`
 * and the existing `AuditSinkPort` from task 1.3. No new event type and no second
 * sink: the audit table, its partitions and its masking rules are task 1.1's, and
 * this is a caller of them.
 *
 * The entry records *why* the block happened, not *what* the user wrote. Evidence
 * terms travel; the submitted caption, lyrics and script do not. A block is not a
 * reason to copy user content into an append-only table that cannot later be
 * corrected.
 */

import type { AuditLogDraft } from '../../domain/audit-log/entry';

import type { BlockedModeration } from './decision';

export interface PolicyBlockAuditInput {
  /** The account whose request was blocked. */
  readonly accountId: string;
  /** The generation request identifier, so the block joins to the request log. */
  readonly requestId: string;
  readonly decision: BlockedModeration;
  readonly eventTimeMs: number;
}

export function policyBlockedDraft(input: PolicyBlockAuditInput): AuditLogDraft {
  return {
    eventType: 'policy_blocked',
    actorId: input.accountId,
    targetId: input.requestId,
    // Nothing existed before a blocked request, so there is no prior state.
    beforeValue: null,
    afterValue: {
      blockCodes: input.decision.blocks.map((block) => block.code),
      violationClasses: input.decision.violationClasses,
      evidence: evidenceOf(input.decision),
      inspectedFields: input.decision.texts.map((text) => text.field),
      // Requirements 16.2 and 16.11: the block carried no charge.
      creditsCharged: 0,
    },
    eventTime: new Date(input.eventTimeMs),
  };
}

function evidenceOf(decision: BlockedModeration): readonly string[] {
  return decision.blocks.flatMap((block) =>
    block.code === 'policy_violation' ? block.violations.map((violation) => violation.evidence) : [],
  );
}
