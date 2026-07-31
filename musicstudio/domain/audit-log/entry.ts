/**
 * Audit log entry shape (design §4.4).
 *
 * Append-only: there is no update or delete counterpart anywhere in the product
 * layer, and the database enforces the same (0008_audit_log.sql).
 */

import { isMaskedApiKey, isMaskedEmail, maskApiKey, maskEmail } from './masking';

/** Events design §4.4 requires to be recorded. */
export const AUDIT_EVENT_TYPES = [
  'credit_changed',
  'visibility_changed',
  'asset_deleted',
  'policy_blocked',
  'api_key_issued',
  'api_key_revoked',
  'consent_recorded',
  'license_changed',
  'engine_state_changed',
  // Requirement 6.3: a Generation_Job whose retries are spent, or which timed
  // out (5.8), is recorded here. `event_type` is `text` in 0008_audit_log.sql, so
  // this member needs no migration.
  'generation_job_failed',
  'commercial_use_denied',
  'quality_threshold_changed',
  // Requirement 26 (task 6.2). `consent_recorded` above already covers 26.15, and
  // `visibility_changed` covers 26.33's unpublishing; these are the events with no
  // existing member. `event_type` is `text` in 0008_audit_log.sql, so no migration
  // is needed for any of them.
  /** 26.28 — a consent withdrawal claim was accepted. */
  'consent_withdrawal_received',
  /** 26.32 — the claimant's identity was verified; the profile is withdrawn. */
  'consent_withdrawal_verified',
  /** 26.34 — verification failed or lapsed; the profile was restored. */
  'consent_withdrawal_reverted',
  /** 26.36 — the owner objected and an operator review item was raised. */
  'consent_withdrawal_objection',
  /** 26.23 — a Voice_Profile was deleted at the owner's request. */
  'voice_profile_deleted',
  /** 26.19 — the profile's share list changed. */
  'voice_profile_sharing_changed',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export function isAuditEventType(value: unknown): value is AuditEventType {
  return typeof value === 'string' && (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

export interface AuditLogEntry {
  readonly eventType: AuditEventType;
  readonly actorId: string | null;
  readonly targetId: string | null;
  /** Already masked — the raw address never reaches this type. */
  readonly actorEmailMasked: string | null;
  /** Already masked — the raw key never reaches this type. */
  readonly apiKeyMasked: string | null;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly eventTime: Date;
}

export interface AuditLogDraft {
  readonly eventType: AuditEventType;
  readonly actorId?: string | null;
  readonly targetId?: string | null;
  /** Raw address; masked on the way in so no call site has to remember. */
  readonly actorEmail?: string | null;
  /** Raw key; masked on the way in. */
  readonly apiKey?: string | null;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
  readonly eventTime?: Date;
}

/** Build an entry, masking PII at the boundary so it can never be stored raw. */
export function buildAuditLogEntry(draft: AuditLogDraft, now: Date = new Date()): AuditLogEntry {
  return {
    eventType: draft.eventType,
    actorId: draft.actorId ?? null,
    targetId: draft.targetId ?? null,
    actorEmailMasked:
      draft.actorEmail === undefined || draft.actorEmail === null
        ? null
        : maskEmail(draft.actorEmail),
    apiKeyMasked:
      draft.apiKey === undefined || draft.apiKey === null ? null : maskApiKey(draft.apiKey),
    beforeValue: draft.beforeValue ?? null,
    afterValue: draft.afterValue ?? null,
    eventTime: draft.eventTime ?? now,
  };
}

/** Guard for the masking invariant, mirrored by CHECK constraints in SQL. */
export function isPiiMasked(entry: AuditLogEntry): boolean {
  const emailOk = entry.actorEmailMasked === null || isMaskedEmail(entry.actorEmailMasked);
  const keyOk = entry.apiKeyMasked === null || isMaskedApiKey(entry.apiKeyMasked);
  return emailOk && keyOk;
}
