import type { AuditLogDraft, AuditEventType } from '../../domain/audit-log/entry';
import { initialWithdrawalContext } from '../../domain/voice/withdrawal-machine';
import type { WithdrawalContext } from '../../domain/voice/withdrawal-machine';
import { ConsentService } from '../../services/voice/consent-service';
import { createVoiceConsentLookup } from '../../services/voice/consent-lookup';
import type {
  GeneratedAssetVisibilityPort,
  IdentityVerdict,
  IdentityVerificationPort,
  OperatorReviewItem,
  OperatorReviewPort,
  VoiceDataErasurePort,
  WithdrawalNotice,
  WithdrawalNotificationPort,
} from '../../services/voice/ports';
import { ProfileAccessService } from '../../services/voice/profile-access-service';
import type {
  VoiceConsentRecordStorePort,
  VoiceProfileConsentRow,
  VoiceProfileStatePort,
  WithdrawalClaim,
  WithdrawalClaimOutcome,
  WithdrawalClaimStorePort,
} from '../../services/voice/store';
import type { VoiceConsentRecord } from '../../domain/voice/consent-record';
import type { VoiceConsentLookupPort } from '../../services/moderation/voice-consent-port';
import { WithdrawalService } from '../../services/voice/withdrawal-service';

import { createMutableClock, type MutableClock } from './mutable-clock';
import { createRecordingAuditSink, type RecordingAuditSink } from './registry-harness';

/**
 * Fakes for the Requirement 26 consent machinery.
 *
 * The audit sink is task 1.3's `RecordingAuditSink`, reused rather than reimplemented:
 * every criterion in Requirement 26 that records an event records it in the same
 * Audit_Log as everything else, and a second recorder would be a second definition of
 * "recorded".
 *
 * The stores are in-memory mirrors of `db/migrations/0011_voice_consent.sql`, with the
 * same mutability rules — `records` has no update method at all, because Requirement
 * 26.14 has no update.
 */

export const VOICE_HARNESS_BASE_URL = 'https://studio.test';

/** Append-only, exactly like the table (Requirement 26.14). */
export interface InMemoryConsentRecordStore extends VoiceConsentRecordStorePort {
  readonly all: readonly VoiceConsentRecord[];
}

export function createInMemoryConsentRecordStore(): InMemoryConsentRecordStore {
  const records: VoiceConsentRecord[] = [];
  return {
    all: records,
    append: (record) => {
      records.push(record);
    },
    recordsFor: (voiceProfileId) =>
      records.filter((record) => record.draft.targetProfileId === voiceProfileId),
  };
}

export interface InMemoryVoiceProfileStore extends VoiceProfileStatePort {
  create(options: {
    readonly voiceProfileId: string;
    readonly ownerId: string;
    readonly sharedUserIds?: readonly string[];
    readonly context?: WithdrawalContext;
  }): VoiceProfileConsentRow;
  rows(): readonly VoiceProfileConsentRow[];
}

export function createInMemoryVoiceProfileStore(): InMemoryVoiceProfileStore {
  const rows = new Map<string, VoiceProfileConsentRow>();

  return {
    create(options) {
      const row: VoiceProfileConsentRow = {
        voiceProfileId: options.voiceProfileId,
        ownerId: options.ownerId,
        context: options.context ?? initialWithdrawalContext(),
        sharedUserIds: options.sharedUserIds ?? [],
        deletedAtMs: null,
      };
      rows.set(row.voiceProfileId, row);
      return row;
    },
    rows: () => [...rows.values()],
    find: (voiceProfileId) => rows.get(voiceProfileId),
    saveContext: (voiceProfileId, context) => {
      const row = rows.get(voiceProfileId);
      if (row === undefined) return;
      rows.set(voiceProfileId, { ...row, context });
    },
    saveSharedUserIds: (voiceProfileId, sharedUserIds) => {
      const row = rows.get(voiceProfileId);
      if (row === undefined) return;
      rows.set(voiceProfileId, { ...row, sharedUserIds });
    },
    markDeleted: (voiceProfileId, deletedAtMs) => {
      const row = rows.get(voiceProfileId);
      if (row === undefined) return;
      rows.set(voiceProfileId, { ...row, deletedAtMs });
    },
  };
}

export interface InMemoryWithdrawalClaimStore extends WithdrawalClaimStorePort {
  readonly all: readonly WithdrawalClaim[];
}

export function createInMemoryWithdrawalClaimStore(): InMemoryWithdrawalClaimStore {
  let claims: WithdrawalClaim[] = [];

  return {
    get all() {
      return claims;
    },
    append: (claim) => {
      claims.push(claim);
    },
    claimsFor: (voiceProfileId) =>
      claims.filter((claim) => claim.voiceProfileId === voiceProfileId),
    setOutcome: (withdrawalClaimId, outcome: WithdrawalClaimOutcome) => {
      claims = claims.map((claim) =>
        claim.withdrawalClaimId === withdrawalClaimId ? { ...claim, outcome } : claim,
      );
    },
  };
}

/** Requirement 26.31 — a scriptable verifier. No biometrics anywhere near it. */
export interface ScriptedIdentityVerification extends IdentityVerificationPort {
  setVerdict(verdict: IdentityVerdict): void;
  readonly submissions: readonly { readonly withdrawalClaimId: string }[];
}

export function createScriptedIdentityVerification(
  initial: IdentityVerdict = 'rejected',
): ScriptedIdentityVerification {
  let verdict = initial;
  const submissions: { withdrawalClaimId: string }[] = [];

  return {
    submissions,
    setVerdict: (next) => {
      verdict = next;
    },
    verify: (submission) => {
      submissions.push({ withdrawalClaimId: submission.withdrawalClaimId });
      return verdict;
    },
  };
}

/**
 * Stands in for Sharing_Service (task 5.3).
 *
 * `privateCalls` is recorded so a test can assert that a `잠정_사용_제한` transition made
 * **no** call at all — which is how Requirement 26.30 is checked. Asserting on the
 * resulting visibility alone would pass even if the code called `makePrivate` with an
 * empty list, and an empty-list call against a real Sharing_Service is not obviously a
 * no-op.
 */
export interface RecordingAssetVisibility extends GeneratedAssetVisibilityPort {
  publish(voiceProfileId: string, assetIds: readonly string[]): void;
  readonly privateCalls: readonly { readonly assetIds: readonly string[]; readonly dueAtMs: number }[];
  publicAssetsOf(voiceProfileId: string): readonly string[];
}

export function createRecordingAssetVisibility(): RecordingAssetVisibility {
  const published = new Map<string, string[]>();
  const privateCalls: { assetIds: readonly string[]; dueAtMs: number }[] = [];

  return {
    privateCalls,
    publish: (voiceProfileId, assetIds) => {
      published.set(voiceProfileId, [...assetIds]);
    },
    publicAssetsOf: (voiceProfileId) => published.get(voiceProfileId) ?? [],
    publicAssetIdsFor: (voiceProfileId) => published.get(voiceProfileId) ?? [],
    makePrivate: (assetIds, dueAtMs) => {
      privateCalls.push({ assetIds: [...assetIds], dueAtMs });
      for (const [profileId, ids] of published) {
        published.set(
          profileId,
          ids.filter((id) => !assetIds.includes(id)),
        );
      }
    },
  };
}

export interface RecordingErasure extends VoiceDataErasurePort {
  readonly calls: readonly { readonly voiceProfileId: string; readonly dueAtMs: number }[];
}

export function createRecordingErasure(): RecordingErasure {
  const calls: { voiceProfileId: string; dueAtMs: number }[] = [];
  return {
    calls,
    eraseReferenceData: (voiceProfileId, dueAtMs) => {
      calls.push({ voiceProfileId, dueAtMs });
    },
  };
}

export interface RecordingNotifications extends WithdrawalNotificationPort {
  readonly notices: readonly WithdrawalNotice[];
}

export function createRecordingNotifications(): RecordingNotifications {
  const notices: WithdrawalNotice[] = [];
  return {
    notices,
    notify: (notice) => {
      notices.push(notice);
    },
  };
}

export interface RecordingOperatorReview extends OperatorReviewPort {
  readonly items: readonly OperatorReviewItem[];
}

export function createRecordingOperatorReview(): RecordingOperatorReview {
  const items: OperatorReviewItem[] = [];
  return {
    items,
    submit: (item) => {
      items.push(item);
    },
  };
}

export interface VoiceConsentHarness {
  readonly consent: ConsentService;
  readonly withdrawal: WithdrawalService;
  readonly access: ProfileAccessService;
  readonly lookup: VoiceConsentLookupPort;
  readonly records: InMemoryConsentRecordStore;
  readonly profiles: InMemoryVoiceProfileStore;
  readonly claims: InMemoryWithdrawalClaimStore;
  readonly identity: ScriptedIdentityVerification;
  readonly visibility: RecordingAssetVisibility;
  readonly erasure: RecordingErasure;
  readonly notifications: RecordingNotifications;
  readonly operatorReview: RecordingOperatorReview;
  readonly audit: RecordingAuditSink;
  readonly clock: MutableClock;
  /** Audit drafts of one event type, in order. */
  auditOf(eventType: AuditEventType): readonly AuditLogDraft[];
  advanceDays(days: number): void;
  advanceHours(hours: number): void;
}

export interface VoiceConsentHarnessOptions {
  readonly startAt?: Date;
  /**
   * Share the gateway's clock, so an HTTP test advances one time source rather than two.
   * Every Requirement 26 window is clock-injected; two clocks would let the routes and
   * the services disagree about whether 14 days had passed.
   */
  readonly clock?: MutableClock;
}

export function createVoiceConsentHarness(
  options: VoiceConsentHarnessOptions = {},
): VoiceConsentHarness {
  const clock =
    options.clock ?? createMutableClock(options.startAt ?? new Date('2025-04-01T00:00:00.000Z'));
  const audit = createRecordingAuditSink();
  const records = createInMemoryConsentRecordStore();
  const profiles = createInMemoryVoiceProfileStore();
  const claims = createInMemoryWithdrawalClaimStore();
  const identity = createScriptedIdentityVerification();
  const visibility = createRecordingAssetVisibility();
  const erasure = createRecordingErasure();
  const notifications = createRecordingNotifications();
  const operatorReview = createRecordingOperatorReview();

  let consentSequence = 0;
  let idSequence = 0;

  const consent = new ConsentService({
    records,
    clock,
    auditSink: audit,
    publicBaseUrl: VOICE_HARNESS_BASE_URL,
    newConsentRecordId: () => `consent-${String(++consentSequence)}`,
  });

  const access = new ProfileAccessService({ profiles, clock, auditSink: audit, erasure });

  const withdrawal = new WithdrawalService({
    profiles,
    claims,
    records,
    clock,
    auditSink: audit,
    identityVerification: identity,
    assetVisibility: visibility,
    erasure,
    notifications,
    operatorReview,
    publicBaseUrl: VOICE_HARNESS_BASE_URL,
    newId: () => `wd-${String(++idSequence)}`,
  });

  return {
    consent,
    withdrawal,
    access,
    lookup: createVoiceConsentLookup({ records, access }),
    records,
    profiles,
    claims,
    identity,
    visibility,
    erasure,
    notifications,
    operatorReview,
    audit,
    clock,
    auditOf: (eventType) => audit.drafts.filter((draft) => draft.eventType === eventType),
    advanceDays: (days) => clock.advanceSeconds(days * 86_400),
    advanceHours: (hours) => clock.advanceSeconds(hours * 3_600),
  };
}
