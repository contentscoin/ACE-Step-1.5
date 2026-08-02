/**
 * Consent withdrawal intake, verification and revert (Requirements 26.28, 26.31–26.36).
 *
 * The service owns **no rules**. Every decision comes from
 * `domain/voice/withdrawal-machine.ts` and `domain/voice/withdrawal-quota.ts`; this layer
 * reads the clock, applies the quota, calls the machine, persists the resulting context
 * and then executes the returned effects through ports. That split is what lets the
 * 24-hour, 14-day and 30-day windows be tested by advancing a `Clock` rather than
 * waiting.
 *
 * The one ordering that matters: **effects run after the state is persisted.** If an
 * effect fails, the profile is already restricted — which is the safe direction. Running
 * effects first would risk unpublishing assets for a transition that never committed.
 */

import { randomUUID } from 'node:crypto';

import type { AuditSinkPort } from '../../adapters/registry/ports';
import { refusesGenerationForWithdrawal } from '../../domain/voice/consent-state';
import {
  MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
  WITHDRAWAL_CLAIM_WINDOW_MS,
  evaluateWithdrawalQuota,
} from '../../domain/voice/withdrawal-quota';
import {
  applyWithdrawalEvent,
  effectOf,
  isVerificationWindowElapsed,
  verificationDeadlineMs,
  type WithdrawalEventKind,
  type WithdrawalTransition,
} from '../../domain/voice/withdrawal-machine';
import type { Clock } from '../clock';

import {
  assetsMadePrivateDraft,
  objectionDraft,
  withdrawalTransitionDraft,
} from './audit';
import {
  profileNotFound,
  withdrawalCapExceeded,
  withdrawalStateConflict,
} from './errors';
import type {
  GeneratedAssetVisibilityPort,
  IdentityEvidenceSubmission,
  IdentityVerificationPort,
  OperatorReviewPort,
  WithdrawalNotificationPort,
} from './ports';
import { RESPONSIBLE_USE_GUIDE_PATH } from './responsible-use';
import type {
  VoiceConsentRecordStorePort,
  VoiceProfileConsentRow,
  VoiceProfileStatePort,
  WithdrawalClaim,
  WithdrawalClaimStorePort,
} from './store';

export interface WithdrawalServiceDependencies {
  readonly profiles: VoiceProfileStatePort;
  readonly claims: WithdrawalClaimStorePort;
  readonly records: VoiceConsentRecordStorePort;
  readonly clock: Clock;
  readonly auditSink: AuditSinkPort;
  readonly identityVerification: IdentityVerificationPort;
  /** Sharing_Service's seam (task 5.3). */
  readonly assetVisibility: GeneratedAssetVisibilityPort;
  readonly erasure: { eraseReferenceData(voiceProfileId: string, dueAtMs: number): void };
  readonly notifications: WithdrawalNotificationPort;
  readonly operatorReview: OperatorReviewPort;
  readonly publicBaseUrl: string;
  readonly newId?: () => string;
}

export interface WithdrawalIntakeRequest {
  readonly voiceProfileId: string;
  /** `null` when the claim arrived through the contact on the consent record. */
  readonly claimantAccountId: string | null;
  readonly intakeChannel: WithdrawalClaim['intakeChannel'];
  /** Requirement 26.28's 접수 시각, if the claim was queued before being processed. */
  readonly receivedAtMs?: number;
}

export interface WithdrawalIntakeResult {
  readonly claim: WithdrawalClaim;
  readonly transition: WithdrawalTransition;
  /** Requirement 26.31 — when identity material is due. */
  readonly identityVerificationDueAtMs: number;
  /** Requirement 26.28 — how the owner objects. */
  readonly objectionUrl: string;
}

export class WithdrawalService {
  private readonly deps: WithdrawalServiceDependencies;
  private readonly newId: () => string;

  constructor(deps: WithdrawalServiceDependencies) {
    this.deps = deps;
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /**
   * Requirement 26.28 — accept a claim and move the profile to `잠정_사용_제한`.
   *
   * The quota check (26.35) runs **before** the state machine, so a refused fourth claim
   * leaves the profile exactly as it was. Checking afterwards would already have
   * restricted the profile by the time the cap was noticed.
   */
  receiveWithdrawal(request: WithdrawalIntakeRequest): WithdrawalIntakeResult {
    const row = this.requireProfile(request.voiceProfileId);
    const nowMs = this.deps.clock.now().getTime();
    const receivedAtMs = request.receivedAtMs ?? nowMs;

    this.assertWithinClaimCap(row, nowMs);

    const result = applyWithdrawalEvent(row.context, {
      kind: '동의_철회_접수',
      atMs: nowMs,
      claimReceivedAtMs: receivedAtMs,
    });
    if (result.outcome === 'refused') {
      throw withdrawalStateConflict({
        voiceProfileId: row.voiceProfileId,
        from: result.from,
        reason: result.reason,
      });
    }

    const claim: WithdrawalClaim = {
      withdrawalClaimId: this.newId(),
      voiceProfileId: row.voiceProfileId,
      claimantAccountId: request.claimantAccountId,
      intakeChannel: request.intakeChannel,
      receivedAtMs,
      outcome: 'pending',
    };
    this.deps.claims.append(claim);

    const { transition } = result;
    this.commit(row, transition, claim.withdrawalClaimId, request.claimantAccountId);

    const objectionUrl = this.objectionUrl(row.voiceProfileId);
    // Requirement 26.28 — the owner learns of the intake and how to object.
    this.deps.notifications.notify({
      kind: 'withdrawal_received',
      audience: 'owner',
      voiceProfileId: row.voiceProfileId,
      withdrawalClaimId: claim.withdrawalClaimId,
      objectionUrl,
      sentAtMs: nowMs,
    });

    return {
      claim,
      transition,
      identityVerificationDueAtMs:
        effectOf(transition, 'require_identity_verification')?.dueAtMs ?? nowMs,
      objectionUrl,
    };
  }

  /**
   * Requirements 26.31, 26.32, 26.34 — submit identity evidence and act on the verdict.
   *
   * A `pending` verdict changes nothing: the claim stays open and the 14-day clock keeps
   * running, so a verifier that needs a human review cannot accidentally restore the
   * profile.
   */
  submitIdentityEvidence(
    voiceProfileId: string,
    submission: Omit<IdentityEvidenceSubmission, 'submittedAtMs'>,
  ): WithdrawalTransition | null {
    const row = this.requireProfile(voiceProfileId);
    const nowMs = this.deps.clock.now().getTime();

    // Requirement 26.34 — material arriving after the window has closed does not
    // reopen it. The lapse is applied instead, which is the outcome the criterion
    // already made due.
    if (isVerificationWindowElapsed(row.context, nowMs)) {
      return this.expireVerification(voiceProfileId);
    }

    const verdict = this.deps.identityVerification.verify({
      ...submission,
      submittedAtMs: nowMs,
    });
    if (verdict === 'pending') return null;

    const event: WithdrawalEventKind =
      verdict === 'verified' ? '신원_확인_성공' : '신원_확인_실패';
    this.deps.claims.setOutcome(
      submission.withdrawalClaimId,
      verdict === 'verified' ? 'verified' : 'rejected',
    );

    return this.applyAndCommit(row, event, nowMs, submission.withdrawalClaimId);
  }

  /**
   * Requirement 26.34 — the 14-day lapse, applied by the scheduled sweep.
   *
   * Idempotent by way of the state machine: a second call finds the profile no longer in
   * `잠정_사용_제한` and the machine refuses, so the sweep may run as often as it likes.
   */
  expireVerification(voiceProfileId: string): WithdrawalTransition | null {
    const row = this.requireProfile(voiceProfileId);
    const nowMs = this.deps.clock.now().getTime();

    const result = applyWithdrawalEvent(row.context, {
      kind: '신원_확인_기한_경과',
      atMs: nowMs,
    });
    if (result.outcome === 'refused') return null;

    const claimId = this.openClaimIdOf(row.voiceProfileId);
    if (claimId !== null) this.deps.claims.setOutcome(claimId, 'expired');

    this.commit(row, result.transition, claimId, null);
    return result.transition;
  }

  /** Every profile whose 14-day window has closed — the sweep's work list. */
  lapsedProfileIds(voiceProfileIds: readonly string[]): readonly string[] {
    const nowMs = this.deps.clock.now().getTime();
    return voiceProfileIds.filter((id) => {
      const row = this.deps.profiles.find(id);
      return row !== undefined && isVerificationWindowElapsed(row.context, nowMs);
    });
  }

  /**
   * Requirement 26.36 — the owner's objection becomes an operator review item.
   *
   * The objection does **not** change the state. An objection that lifted the
   * restriction by itself would make the whole two-stage design pointless, since the
   * owner is exactly the party the restriction constrains. An operator decides, and the
   * decision arrives as 26.32's verification or 26.34's revert.
   *
   * There has to *be* something to object to. 26.36 is about an objection "잠정 사용
   * 제한에 대한", so a profile in `정상` has nothing pending and the request is a 409
   * rather than a review item an operator would have to close as meaningless. The check
   * also guarantees the review item names a real claim: without it the item would carry
   * an empty claim id, and an operator cannot read the disputed claim from that.
   */
  submitObjection(input: {
    readonly voiceProfileId: string;
    readonly ownerId: string;
    readonly objection: string;
  }): string {
    const row = this.requireProfile(input.voiceProfileId);
    const nowMs = this.deps.clock.now().getTime();
    const claimId = this.objectionTargetClaimIdOf(row);
    const consentRecords = this.deps.records.recordsFor(row.voiceProfileId);
    const reviewItemId = this.newId();

    this.deps.operatorReview.submit({
      reviewItemId,
      voiceProfileId: row.voiceProfileId,
      withdrawalClaimId: claimId,
      ownerId: input.ownerId,
      objection: input.objection,
      consentRecords,
      submittedAtMs: nowMs,
    });

    this.deps.auditSink.record(
      objectionDraft({
        voiceProfileId: row.voiceProfileId,
        ownerId: input.ownerId,
        withdrawalClaimId: claimId,
        reviewItemId,
        consentRecordCount: consentRecords.length,
        eventTimeMs: nowMs,
      }),
    );

    return reviewItemId;
  }

  /** Requirement 26.31 — the deadline shown to the claimant. */
  verificationDeadlineOf(voiceProfileId: string): number | null {
    const row = this.deps.profiles.find(voiceProfileId);
    return row === undefined ? null : verificationDeadlineMs(row.context);
  }

  private applyAndCommit(
    row: VoiceProfileConsentRow,
    event: WithdrawalEventKind,
    nowMs: number,
    claimId: string | null,
  ): WithdrawalTransition {
    const result = applyWithdrawalEvent(row.context, { kind: event, atMs: nowMs });
    if (result.outcome === 'refused') {
      throw withdrawalStateConflict({
        voiceProfileId: row.voiceProfileId,
        from: result.from,
        reason: result.reason,
      });
    }

    this.commit(row, result.transition, claimId, null);
    return result.transition;
  }

  /** Persist first, then run effects. See the module comment for why that order. */
  private commit(
    row: VoiceProfileConsentRow,
    transition: WithdrawalTransition,
    claimId: string | null,
    actorId: string | null,
  ): void {
    this.deps.profiles.saveContext(row.voiceProfileId, transition.next);

    this.deps.auditSink.record(
      withdrawalTransitionDraft({
        voiceProfileId: row.voiceProfileId,
        withdrawalClaimId: claimId,
        actorId,
        transition,
      }),
    );

    this.runEffects(row, transition, claimId);
  }

  private runEffects(
    row: VoiceProfileConsentRow,
    transition: WithdrawalTransition,
    claimId: string | null,
  ): void {
    for (const effect of transition.effects) {
      switch (effect.kind) {
        case 'erase_voice_data':
          // Requirements 26.21, 26.32.
          this.deps.erasure.eraseReferenceData(row.voiceProfileId, effect.dueAtMs ?? 0);
          break;

        case 'unpublish_generated_assets':
          // Requirement 26.33 — reached only from `사용_중지`. The state machine emits
          // this effect for no other transition; `mutatesAssetVisibility` is the guard
          // and `test/unit/voice/withdrawal-machine.test.ts` asserts it exhaustively.
          this.unpublish(row, effect.dueAtMs ?? transition.atMs, claimId);
          break;

        case 'notify_claimant':
          this.deps.notifications.notify({
            kind: 'withdrawal_reverted',
            audience: 'claimant',
            voiceProfileId: row.voiceProfileId,
            withdrawalClaimId: claimId,
            sentAtMs: transition.atMs,
          });
          break;

        case 'notify_owner':
          if (transition.event === '신원_확인_실패' || transition.event === '신원_확인_기한_경과') {
            // Requirement 26.34.
            this.deps.notifications.notify({
              kind: 'withdrawal_reverted',
              audience: 'owner',
              voiceProfileId: row.voiceProfileId,
              withdrawalClaimId: claimId,
              sentAtMs: transition.atMs,
            });
          }
          // The intake notice (26.28) and the 26.33 asset notice carry payloads this
          // loop does not have, so they are sent by their own call sites.
          break;

        case 'preserve_asset_visibility':
        case 'preserve_generated_assets':
        case 'require_identity_verification':
          // Obligations, not actions. They exist so the *absence* of a change is part
          // of the transition record (26.23, 26.30) rather than an omission.
          break;
      }
    }
  }

  /** Requirement 26.33 — private within 24 hours, and the owner told which assets. */
  private unpublish(
    row: VoiceProfileConsentRow,
    dueAtMs: number,
    claimId: string | null,
  ): void {
    const assetIds = this.deps.assetVisibility.publicAssetIdsFor(row.voiceProfileId);
    if (assetIds.length > 0) {
      this.deps.assetVisibility.makePrivate(assetIds, dueAtMs);
    }

    this.deps.auditSink.record(
      assetsMadePrivateDraft({
        voiceProfileId: row.voiceProfileId,
        ownerId: row.ownerId,
        assetIds,
        dueAtMs,
        eventTimeMs: this.deps.clock.now().getTime(),
      }),
    );

    this.deps.notifications.notify({
      kind: 'assets_made_private',
      audience: 'owner',
      voiceProfileId: row.voiceProfileId,
      withdrawalClaimId: claimId,
      assetIds,
      sentAtMs: this.deps.clock.now().getTime(),
    });
  }

  /** Requirement 26.35. */
  private assertWithinClaimCap(row: VoiceProfileConsentRow, nowMs: number): void {
    const instants = this.deps.claims
      .claimsFor(row.voiceProfileId)
      .map((claim) => claim.receivedAtMs);
    const decision = evaluateWithdrawalQuota(instants, nowMs);

    if (decision.outcome === 'cap_exceeded') {
      throw withdrawalCapExceeded({
        voiceProfileId: row.voiceProfileId,
        limit: decision.limit,
        countInWindow: decision.countInWindow,
        windowDays: WITHDRAWAL_CLAIM_WINDOW_MS / 86_400_000,
        nextEligibleAtMs: decision.nextEligibleAtMs,
      });
    }
  }

  /**
   * Requirement 26.36 — the claim an objection disputes.
   *
   * `잠정_사용_제한` is the criterion's own case and its claim is still `pending`.
   * `사용_중지` is admitted too, and deliberately so: the owner's dispute does not stop
   * being worth reviewing the moment verification succeeds, and that claim's outcome is
   * `verified` rather than `pending` — hence the fallback to the most recent claim of any
   * outcome rather than only an open one.
   */
  private objectionTargetClaimIdOf(row: VoiceProfileConsentRow): string {
    if (!refusesGenerationForWithdrawal(row.context.state)) {
      throw withdrawalStateConflict({
        voiceProfileId: row.voiceProfileId,
        from: row.context.state,
        reason: 'state_not_applicable',
      });
    }

    const claimId = this.openClaimIdOf(row.voiceProfileId) ?? this.latestClaimIdOf(row.voiceProfileId);
    if (claimId === null) {
      throw withdrawalStateConflict({
        voiceProfileId: row.voiceProfileId,
        from: row.context.state,
        reason: 'state_not_applicable',
      });
    }
    return claimId;
  }

  private latestClaimIdOf(voiceProfileId: string): string | null {
    const claims = [...this.deps.claims.claimsFor(voiceProfileId)].sort(
      (left, right) => right.receivedAtMs - left.receivedAtMs,
    );
    return claims[0]?.withdrawalClaimId ?? null;
  }

  private openClaimIdOf(voiceProfileId: string): string | null {
    const pending = this.deps.claims
      .claimsFor(voiceProfileId)
      .filter((claim) => claim.outcome === 'pending')
      .sort((left, right) => right.receivedAtMs - left.receivedAtMs);

    return pending[0]?.withdrawalClaimId ?? null;
  }

  private requireProfile(voiceProfileId: string): VoiceProfileConsentRow {
    const row = this.deps.profiles.find(voiceProfileId);
    // Requirement 26.22 — a deleted profile answers 404, the same as an unknown one.
    if (row === undefined || row.context.state === '삭제됨') {
      throw profileNotFound(voiceProfileId);
    }
    return row;
  }

  private objectionUrl(voiceProfileId: string): string {
    return new URL(
      `${RESPONSIBLE_USE_GUIDE_PATH}#objection?profile=${encodeURIComponent(voiceProfileId)}`,
      this.deps.publicBaseUrl,
    ).toString();
  }
}

export { MAX_WITHDRAWAL_CLAIMS_PER_WINDOW };
