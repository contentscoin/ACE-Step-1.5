/**
 * Audit drafts for the consent machinery (Requirements 26.15, 26.19, 26.23, 26.28,
 * 26.32, 26.34, 26.36).
 *
 * Uses task 1.1's `AuditLogDraft` and task 1.3's `AuditSinkPort`; no second sink and no
 * second table. `event_type` is `text` in `0008_audit_log.sql`, so the members added to
 * `AUDIT_EVENT_TYPES` for these events need no migration.
 *
 * What is recorded is the *decision*, not the evidence. A withdrawal claim's identity
 * document reference, the speaker's identifying details and the objection text stay out
 * of the append-only log: those are the most sensitive fields in the whole feature, and
 * an append-only table is precisely where a mistake cannot later be corrected. The
 * claim id is recorded instead, which is enough for a reviewer to find the rest through
 * the store that *can* be corrected.
 */

import type { AuditLogDraft } from '../../domain/audit-log/entry';
import type { ConsentRecordKind } from '../../domain/voice/consent-record';
import type { VoiceProfileConsentState } from '../../domain/voice/consent-state';
import type { WithdrawalTransition } from '../../domain/voice/withdrawal-machine';

/** Requirement 26.15 — a Voice_Consent_Record was stored. */
export function consentRecordedDraft(input: {
  readonly submitterId: string;
  readonly voiceProfileId: string;
  readonly consentRecordId: string;
  readonly kind: ConsentRecordKind;
  readonly eventTimeMs: number;
}): AuditLogDraft {
  return {
    eventType: 'consent_recorded',
    actorId: input.submitterId,
    targetId: input.voiceProfileId,
    beforeValue: null,
    afterValue: {
      consentRecordId: input.consentRecordId,
      consentRecordKind: input.kind,
      // Requirement 26.14 — recorded so a reviewer can see the retention basis
      // without reading the record itself.
      immutable: true,
    },
    eventTime: new Date(input.eventTimeMs),
  };
}

/** Requirements 26.28, 26.32, 26.34 — one shape for the three state transitions. */
export function withdrawalTransitionDraft(input: {
  readonly voiceProfileId: string;
  readonly withdrawalClaimId: string | null;
  readonly actorId: string | null;
  readonly transition: WithdrawalTransition;
}): AuditLogDraft {
  const { transition } = input;

  return {
    eventType: eventTypeFor(transition),
    actorId: input.actorId,
    targetId: input.voiceProfileId,
    beforeValue: { consentState: transition.from },
    afterValue: {
      consentState: transition.to,
      event: transition.event,
      withdrawalClaimId: input.withdrawalClaimId,
      effects: transition.effects.map((effect) => effect.kind),
      // Requirement 26.28's 24-hour budget, so a breach is visible in the log rather
      // than only in a metric.
      withinIntakeWindow: transition.withinIntakeWindow,
    },
    eventTime: new Date(transition.atMs),
  };
}

function eventTypeFor(transition: WithdrawalTransition): AuditLogDraft['eventType'] {
  switch (transition.event) {
    case '동의_철회_접수':
      return 'consent_withdrawal_received';
    case '신원_확인_성공':
      return 'consent_withdrawal_verified';
    case '신원_확인_실패':
    case '신원_확인_기한_경과':
      return 'consent_withdrawal_reverted';
    case '소유자_삭제_요청':
    case '데이터_삭제_완료':
      return 'voice_profile_deleted';
  }
}

/** Requirement 26.33 — the assets turned private, and for whom. */
export function assetsMadePrivateDraft(input: {
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly assetIds: readonly string[];
  readonly dueAtMs: number;
  readonly eventTimeMs: number;
}): AuditLogDraft {
  return {
    eventType: 'visibility_changed',
    actorId: null,
    targetId: input.voiceProfileId,
    beforeValue: { publicAssetIds: input.assetIds },
    afterValue: {
      publicAssetIds: [],
      reason: 'consent_withdrawn',
      ownerId: input.ownerId,
      dueAtMs: input.dueAtMs,
    },
    eventTime: new Date(input.eventTimeMs),
  };
}

/** Requirement 26.36 — the owner objected; an operator review item was raised. */
export function objectionDraft(input: {
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly withdrawalClaimId: string;
  readonly reviewItemId: string;
  readonly consentRecordCount: number;
  readonly eventTimeMs: number;
}): AuditLogDraft {
  return {
    eventType: 'consent_withdrawal_objection',
    actorId: input.ownerId,
    targetId: input.voiceProfileId,
    beforeValue: null,
    afterValue: {
      reviewItemId: input.reviewItemId,
      withdrawalClaimId: input.withdrawalClaimId,
      // The objection text itself is not copied here; see the module comment.
      consentRecordCount: input.consentRecordCount,
    },
    eventTime: new Date(input.eventTimeMs),
  };
}

/** Requirement 26.19 — the share list changed. */
export function sharingChangedDraft(input: {
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly eventTimeMs: number;
}): AuditLogDraft {
  return {
    eventType: 'voice_profile_sharing_changed',
    actorId: input.ownerId,
    targetId: input.voiceProfileId,
    beforeValue: { sharedUserCount: input.before.length },
    afterValue: { sharedUserCount: input.after.length },
    eventTime: new Date(input.eventTimeMs),
  };
}

/** Requirement 26.23 — owner deletion, with the assets explicitly preserved. */
export function profileDeletedDraft(input: {
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly from: VoiceProfileConsentState;
  readonly erasureDueAtMs: number;
  readonly eventTimeMs: number;
}): AuditLogDraft {
  return {
    eventType: 'voice_profile_deleted',
    actorId: input.ownerId,
    targetId: input.voiceProfileId,
    beforeValue: { consentState: input.from },
    afterValue: {
      consentState: '삭제됨',
      erasureDueAtMs: input.erasureDueAtMs,
      // Requirement 26.23, stated so the log shows the asset decision was made.
      generatedAssetsPreserved: true,
    },
    eventTime: new Date(input.eventTimeMs),
  };
}
