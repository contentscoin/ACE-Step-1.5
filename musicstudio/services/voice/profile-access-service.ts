/**
 * Voice_Profile use permission, share list and owner deletion
 * (Requirements 26.18–26.23, 26.29).
 *
 * ### The order the two checks are applied in
 *
 * Existence, then consent state, then permission. Concretely:
 *
 * 1. unknown or `삭제됨` -> **404** (26.22)
 * 2. `잠정_사용_제한` or `사용_중지` -> **403** + withdrawal reason code (26.29)
 * 3. not the owner and not on the share list -> **403** (26.20)
 *
 * Putting the withdrawal check before the permission check is deliberate. The owner is
 * always permitted under 26.18, so the reverse order would let the owner keep generating
 * from a profile whose consent has been withdrawn — which is the single most important
 * thing Requirement 26 forbids. The reason code also differs between the two 403s, so a
 * caller can tell "you are not on the list" from "this voice was withdrawn".
 */

import type { AuditSinkPort } from '../../adapters/registry/ports';
import {
  isProfileDeleted,
  refusesGenerationForWithdrawal,
  type VoiceProfileConsentState,
} from '../../domain/voice/consent-state';
import { isUsePermitted, validateShareList } from '../../domain/voice/sharing-list';
import { applyWithdrawalEvent, effectOf } from '../../domain/voice/withdrawal-machine';
import type { Clock } from '../clock';

import { profileDeletedDraft, sharingChangedDraft } from './audit';
import {
  consentWithdrawn,
  profileForbidden,
  profileNotFound,
  shareListInvalid,
  withdrawalStateConflict,
} from './errors';
import type { VoiceDataErasurePort } from './ports';
import { accessOf, type VoiceProfileConsentRow, type VoiceProfileStatePort } from './store';

export interface ProfileAccessServiceDependencies {
  readonly profiles: VoiceProfileStatePort;
  readonly clock: Clock;
  readonly auditSink: AuditSinkPort;
  readonly erasure: VoiceDataErasurePort;
}

export interface ProfileDeletionResult {
  readonly voiceProfileId: string;
  readonly deletedAtMs: number;
  /** Requirement 26.21 — reference data must be gone by this instant. */
  readonly erasureDueAtMs: number;
  /** Requirement 26.23, stated so a caller can surface it. */
  readonly generatedAssetsPreserved: true;
}

export class ProfileAccessService {
  private readonly deps: ProfileAccessServiceDependencies;

  constructor(deps: ProfileAccessServiceDependencies) {
    this.deps = deps;
  }

  /**
   * Requirements 26.18, 26.20, 26.22, 26.29 — the gate Speech_Service (task 2.7) calls.
   *
   * Throws the transport error rather than returning a boolean, so a caller cannot
   * accidentally proceed on a falsy value it forgot to check.
   */
  assertUsable(voiceProfileId: string, requesterId: string): VoiceProfileConsentRow {
    const row = this.deps.profiles.find(voiceProfileId);
    // Requirement 26.22.
    if (row === undefined || isProfileDeleted(row.context.state)) {
      throw profileNotFound(voiceProfileId);
    }

    // Requirement 26.29, before the permission check — see the module comment.
    if (refusesGenerationForWithdrawal(row.context.state)) {
      throw consentWithdrawn(voiceProfileId, row.context.state);
    }

    // Requirements 26.18, 26.20.
    if (!isUsePermitted(accessOf(row), requesterId)) {
      throw profileForbidden(voiceProfileId);
    }

    return row;
  }

  /** Non-throwing form, for the `VoiceConsentLookupPort` and read-only callers. */
  isUsable(voiceProfileId: string, requesterId: string): boolean {
    const row = this.deps.profiles.find(voiceProfileId);
    if (row === undefined || isProfileDeleted(row.context.state)) return false;
    if (refusesGenerationForWithdrawal(row.context.state)) return false;
    return isUsePermitted(accessOf(row), requesterId);
  }

  consentStateOf(voiceProfileId: string): VoiceProfileConsentState | null {
    return this.deps.profiles.find(voiceProfileId)?.context.state ?? null;
  }

  /**
   * Owner-only gate for the share list, deletion and the 26.36 objection.
   *
   * Note that this does **not** apply the 26.29 withdrawal check: an owner whose profile
   * is under a withdrawal claim must still be able to object to it (26.36) and to delete
   * the profile (26.21). Those are the two owner actions a restriction must not block, or
   * the provisional stage would be unappealable.
   */
  assertOwner(voiceProfileId: string, ownerId: string): VoiceProfileConsentRow {
    return this.requireOwner(voiceProfileId, ownerId);
  }

  /**
   * Requirement 26.19 — replace the share list. Owner only.
   *
   * The whole list is replaced rather than patched, because 26.19 bounds the list as a
   * whole; an add-one endpoint would have to re-derive the bound on every call and would
   * make the audit entry describe a delta instead of a state.
   */
  setSharedUsers(
    voiceProfileId: string,
    ownerId: string,
    proposed: readonly string[],
  ): readonly string[] {
    const row = this.requireOwner(voiceProfileId, ownerId);
    const validation = validateShareList(row.ownerId, proposed);

    if (validation.outcome === 'invalid') {
      throw shareListInvalid({
        voiceProfileId,
        violation: validation.violation,
        min: validation.min,
        max: validation.max,
        received: validation.received,
      });
    }

    const before = row.sharedUserIds;
    this.deps.profiles.saveSharedUserIds(voiceProfileId, validation.sharedUserIds);

    this.deps.auditSink.record(
      sharingChangedDraft({
        voiceProfileId,
        ownerId,
        before,
        after: validation.sharedUserIds,
        eventTimeMs: this.deps.clock.now().getTime(),
      }),
    );

    return validation.sharedUserIds;
  }

  /** Requirement 26.19 — removing sharing entirely. */
  clearSharedUsers(voiceProfileId: string, ownerId: string): void {
    const row = this.requireOwner(voiceProfileId, ownerId);
    const before = row.sharedUserIds;
    if (before.length === 0) return;

    this.deps.profiles.saveSharedUserIds(voiceProfileId, []);
    this.deps.auditSink.record(
      sharingChangedDraft({
        voiceProfileId,
        ownerId,
        before,
        after: [],
        eventTimeMs: this.deps.clock.now().getTime(),
      }),
    );
  }

  /**
   * Requirements 26.21, 26.22, 26.23 — the owner's deletion.
   *
   * Erasure covers the reference samples, embeddings and cached prompts, within 24 hours.
   * Already-generated Audio_Assets are untouched (26.23): the state machine emits
   * `preserve_generated_assets` and no visibility effect, which is what distinguishes this
   * from 26.33's withdrawal path. Deleting a profile is not a retraction of consent, and
   * treating it as one would silently unpublish a creator's back catalogue.
   */
  deleteProfile(voiceProfileId: string, ownerId: string): ProfileDeletionResult {
    const row = this.requireOwner(voiceProfileId, ownerId);
    const nowMs = this.deps.clock.now().getTime();

    const result = applyWithdrawalEvent(row.context, {
      kind: '소유자_삭제_요청',
      atMs: nowMs,
    });
    if (result.outcome === 'refused') {
      throw withdrawalStateConflict({
        voiceProfileId,
        from: result.from,
        reason: result.reason,
      });
    }

    const { transition } = result;
    const erasureDueAtMs = effectOf(transition, 'erase_voice_data')?.dueAtMs ?? nowMs;

    this.deps.profiles.saveContext(voiceProfileId, transition.next);
    this.deps.profiles.markDeleted(voiceProfileId, nowMs);
    this.deps.erasure.eraseReferenceData(voiceProfileId, erasureDueAtMs);

    // Requirement 26.23.
    this.deps.auditSink.record(
      profileDeletedDraft({
        voiceProfileId,
        ownerId,
        from: transition.from,
        erasureDueAtMs,
        eventTimeMs: nowMs,
      }),
    );

    return {
      voiceProfileId,
      deletedAtMs: nowMs,
      erasureDueAtMs,
      generatedAssetsPreserved: true,
    };
  }

  private requireOwner(voiceProfileId: string, ownerId: string): VoiceProfileConsentRow {
    const row = this.deps.profiles.find(voiceProfileId);
    if (row === undefined || isProfileDeleted(row.context.state)) {
      throw profileNotFound(voiceProfileId);
    }
    // Sharing and deletion are owner-only, and a non-owner must not learn the profile
    // exists — so this is the same 403 a non-shared user gets, not a distinct one.
    if (row.ownerId !== ownerId) {
      throw profileForbidden(voiceProfileId);
    }
    return row;
  }
}
