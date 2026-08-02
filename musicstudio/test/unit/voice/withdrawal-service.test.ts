import { beforeEach, describe, expect, it } from 'vitest';

import {
  ASSET_UNPUBLISH_WINDOW_MS,
  IDENTITY_VERIFICATION_WINDOW_MS,
  VOICE_DATA_ERASURE_WINDOW_MS,
} from '../../../domain/voice/windows';
import { isVoiceError, type VoiceError } from '../../../services/voice/errors';
import {
  createVoiceConsentHarness,
  type VoiceConsentHarness,
} from '../../support/voice-consent-harness';

/**
 * Withdrawal intake, verification, revert and objection
 * (Requirements 26.28, 26.30–26.36).
 *
 * Every window here is 24 hours, 14 days or 30 days long, and every one of them is
 * exercised by advancing the injected clock. Nothing sleeps, and nothing is left
 * untested because it takes too long to wait for.
 *
 * The pair of assertions that matters most is 26.30 against 26.33, checked here at the
 * service level rather than only on the pure machine: the provisional stage must make
 * **no call at all** to Sharing_Service, and the withdrawn stage must make exactly one.
 * Asserting on resulting visibility alone would pass even if the code called
 * `makePrivate([])`, which against a real Sharing_Service is not obviously a no-op.
 */

const PROFILE = 'voice-1';
const OWNER = 'owner-1';

let harness: VoiceConsentHarness;

beforeEach(() => {
  harness = createVoiceConsentHarness();
  harness.profiles.create({ voiceProfileId: PROFILE, ownerId: OWNER });
  harness.visibility.publish(PROFILE, ['asset-1', 'asset-2']);
});

function receive(receivedAtMs?: number) {
  return harness.withdrawal.receiveWithdrawal({
    voiceProfileId: PROFILE,
    claimantAccountId: null,
    intakeChannel: 'recorded_contact',
    ...(receivedAtMs === undefined ? {} : { receivedAtMs }),
  });
}

function refusal(call: () => unknown): VoiceError {
  try {
    call();
  } catch (error) {
    if (isVoiceError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('Requirement 26.28 — intake moves the profile to 잠정_사용_제한', () => {
  it('accepts the claim, restricts the profile and states the verification deadline', () => {
    const nowMs = harness.clock.now().getTime();
    const result = receive();

    expect(result.transition.to).toBe('잠정_사용_제한');
    expect(harness.profiles.find(PROFILE)?.context.state).toBe('잠정_사용_제한');
    expect(result.identityVerificationDueAtMs).toBe(nowMs + IDENTITY_VERIFICATION_WINDOW_MS);
    expect(harness.withdrawal.verificationDeadlineOf(PROFILE)).toBe(
      nowMs + IDENTITY_VERIFICATION_WINDOW_MS,
    );
  });

  it('records the claim as pending, with the intake channel', () => {
    receive();

    expect(harness.claims.all).toEqual([
      {
        withdrawalClaimId: 'wd-1',
        voiceProfileId: PROFILE,
        claimantAccountId: null,
        intakeChannel: 'recorded_contact',
        receivedAtMs: harness.clock.now().getTime(),
        outcome: 'pending',
      },
    ]);
  });

  it('accepts a claim with no account — 26.28 admits the recorded contact route', () => {
    expect(receive().claim.claimantAccountId).toBeNull();
  });

  it('notifies the owner of the intake and how to object', () => {
    const result = receive();

    expect(harness.notifications.notices).toEqual([
      {
        kind: 'withdrawal_received',
        audience: 'owner',
        voiceProfileId: PROFILE,
        withdrawalClaimId: 'wd-1',
        objectionUrl: result.objectionUrl,
        sentAtMs: harness.clock.now().getTime(),
      },
    ]);
    expect(result.objectionUrl).toContain('objection');
  });

  it('audits the transition, including whether the 24-hour budget was met', () => {
    const nowMs = harness.clock.now().getTime();
    receive(nowMs - 25 * 3_600_000);

    expect(harness.auditOf('consent_withdrawal_received')[0]).toMatchObject({
      targetId: PROFILE,
      beforeValue: { consentState: '정상' },
      afterValue: { consentState: '잠정_사용_제한', withinIntakeWindow: false },
    });
  });

  it('reports 404 for an unknown profile and for a deleted one alike', () => {
    expect(
      refusal(() =>
        harness.withdrawal.receiveWithdrawal({
          voiceProfileId: 'voice-404',
          claimantAccountId: null,
          intakeChannel: 'in_product',
        }),
      ).statusCode,
    ).toBe(404);

    harness.access.deleteProfile(PROFILE, OWNER);
    expect(refusal(() => receive()).statusCode).toBe(404);
  });

  it('reports a second claim against a restricted profile as a 409', () => {
    receive();
    const error = refusal(() => receive());

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('withdrawal_state_conflict');
    expect(error.details).toMatchObject({ from: '잠정_사용_제한', reason: 'state_not_applicable' });
  });
});

describe('Requirement 26.30 — the provisional stage never touches asset visibility', () => {
  it('makes no call to Sharing_Service at all', () => {
    receive();

    expect(harness.visibility.privateCalls).toEqual([]);
    expect(harness.visibility.publicAssetsOf(PROFILE)).toEqual(['asset-1', 'asset-2']);
  });

  it('erases nothing while the claim is unverified', () => {
    receive();

    expect(harness.erasure.calls).toEqual([]);
  });

  it('leaves visibility untouched right up to the 14-day boundary', () => {
    receive();
    harness.advanceDays(13);

    expect(harness.visibility.publicAssetsOf(PROFILE)).toEqual(['asset-1', 'asset-2']);
    expect(harness.visibility.privateCalls).toEqual([]);
  });
});

describe('Requirements 26.31, 26.32, 26.33 — verification completes the withdrawal', () => {
  beforeEach(() => {
    receive();
  });

  it('26.31 — accepts a spoken challenge phrase, with no biometric matching anywhere', () => {
    harness.identity.setVerdict('verified');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'challenge_phrase_recording',
      evidenceRef: 'upload-1',
    });

    expect(harness.identity.submissions).toEqual([{ withdrawalClaimId: 'wd-1' }]);
    expect(harness.profiles.find(PROFILE)?.context.state).toBe('사용_중지');
  });

  it('26.31 — accepts an identity document just as well', () => {
    harness.identity.setVerdict('verified');
    const transition = harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(transition?.to).toBe('사용_중지');
  });

  it('26.32 — erases the reference data within 24 hours and audits the verification', () => {
    harness.advanceDays(3);
    const nowMs = harness.clock.now().getTime();
    harness.identity.setVerdict('verified');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(harness.erasure.calls).toEqual([
      { voiceProfileId: PROFILE, dueAtMs: nowMs + VOICE_DATA_ERASURE_WINDOW_MS },
    ]);
    expect(harness.auditOf('consent_withdrawal_verified')[0]).toMatchObject({
      afterValue: { consentState: '사용_중지' },
    });
    expect(harness.claims.all[0]?.outcome).toBe('verified');
  });

  it('26.33 — turns public assets private within 24 hours, and names them to the owner', () => {
    const nowMs = harness.clock.now().getTime();
    harness.identity.setVerdict('verified');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(harness.visibility.privateCalls).toEqual([
      { assetIds: ['asset-1', 'asset-2'], dueAtMs: nowMs + ASSET_UNPUBLISH_WINDOW_MS },
    ]);
    expect(harness.visibility.publicAssetsOf(PROFILE)).toEqual([]);
    expect(harness.notifications.notices).toContainEqual({
      kind: 'assets_made_private',
      audience: 'owner',
      voiceProfileId: PROFILE,
      withdrawalClaimId: 'wd-1',
      assetIds: ['asset-1', 'asset-2'],
      sentAtMs: nowMs,
    });
  });

  it('26.33 — audits the visibility change with the reason and the prior asset list', () => {
    harness.identity.setVerdict('verified');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(harness.auditOf('visibility_changed')[0]).toMatchObject({
      targetId: PROFILE,
      beforeValue: { publicAssetIds: ['asset-1', 'asset-2'] },
      afterValue: { publicAssetIds: [], reason: 'consent_withdrawn', ownerId: OWNER },
    });
  });

  it('a pending verdict changes nothing and leaves the 14-day clock running', () => {
    harness.identity.setVerdict('pending');
    const transition = harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(transition).toBeNull();
    expect(harness.profiles.find(PROFILE)?.context.state).toBe('잠정_사용_제한');
    expect(harness.claims.all[0]?.outcome).toBe('pending');
    expect(harness.visibility.privateCalls).toEqual([]);
  });
});

describe('Requirement 26.34 — failure or lapse restores the profile', () => {
  beforeEach(() => {
    receive();
  });

  it('restores on a rejected verdict, notifying both parties', () => {
    harness.identity.setVerdict('rejected');
    const transition = harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(transition?.to).toBe('정상');
    expect(harness.claims.all[0]?.outcome).toBe('rejected');
    expect(harness.notifications.notices.map((notice) => `${notice.kind}:${notice.audience}`))
      .toEqual([
        'withdrawal_received:owner',
        'withdrawal_reverted:owner',
        'withdrawal_reverted:claimant',
      ]);
    expect(harness.auditOf('consent_withdrawal_reverted')).toHaveLength(1);
  });

  it('leaves the profile usable again after a restore', () => {
    harness.identity.setVerdict('rejected');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(harness.access.isUsable(PROFILE, OWNER)).toBe(true);
    // 26.30 held throughout, so there was nothing to republish.
    expect(harness.visibility.publicAssetsOf(PROFILE)).toEqual(['asset-1', 'asset-2']);
    expect(harness.visibility.privateCalls).toEqual([]);
  });

  it('does not expire the claim before 14 days have passed', () => {
    harness.advanceDays(13);

    expect(harness.withdrawal.expireVerification(PROFILE)).toBeNull();
    expect(harness.profiles.find(PROFILE)?.context.state).toBe('잠정_사용_제한');
    expect(harness.withdrawal.lapsedProfileIds([PROFILE])).toEqual([]);
  });

  it('expires the claim at 14 days and restores the profile', () => {
    harness.advanceDays(14);

    expect(harness.withdrawal.lapsedProfileIds([PROFILE, 'voice-404'])).toEqual([PROFILE]);
    const transition = harness.withdrawal.expireVerification(PROFILE);

    expect(transition?.to).toBe('정상');
    expect(harness.claims.all[0]?.outcome).toBe('expired');
    expect(harness.access.isUsable(PROFILE, OWNER)).toBe(true);
  });

  it('is idempotent, so the sweep may run as often as it likes', () => {
    harness.advanceDays(14);
    harness.withdrawal.expireVerification(PROFILE);

    expect(harness.withdrawal.expireVerification(PROFILE)).toBeNull();
    expect(harness.auditOf('consent_withdrawal_reverted')).toHaveLength(1);
  });

  it('treats verification arriving after the window as the lapse, not a promotion', () => {
    harness.advanceDays(15);
    harness.identity.setVerdict('verified');
    const transition = harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(transition?.to).toBe('정상');
    // The verifier is never even consulted: 26.34 had already made the revert due.
    expect(harness.identity.submissions).toEqual([]);
    expect(harness.visibility.privateCalls).toEqual([]);
  });
});

describe('Requirement 26.35 — three claims per 30 days', () => {
  function claimAndRestore(): void {
    receive();
    harness.identity.setVerdict('rejected');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: harness.claims.all[harness.claims.all.length - 1]
        ?.withdrawalClaimId as string,
      kind: 'identity_document',
      evidenceRef: 'doc',
    });
  }

  it('accepts three and refuses the fourth with the cap and the next eligible instant', () => {
    claimAndRestore();
    harness.advanceDays(1);
    claimAndRestore();
    harness.advanceDays(1);
    claimAndRestore();
    harness.advanceDays(1);

    const error = refusal(() => receive());

    expect(error.statusCode).toBe(429);
    expect(error.code).toBe('withdrawal_claim_cap_exceeded');
    expect(error.details).toMatchObject({ limit: 3, countInWindow: 3, windowDays: 30 });
  });

  it('leaves the profile untouched when the cap refuses the claim', () => {
    claimAndRestore();
    harness.advanceDays(1);
    claimAndRestore();
    harness.advanceDays(1);
    claimAndRestore();
    harness.advanceDays(1);
    refusal(() => receive());

    // The cap is checked *before* the state machine, so a refused claim cannot leave a
    // restriction behind.
    expect(harness.profiles.find(PROFILE)?.context.state).toBe('정상');
    expect(harness.claims.all).toHaveLength(3);
  });

  it('admits a fourth claim once the oldest has aged out of the window', () => {
    claimAndRestore();
    harness.advanceDays(1);
    claimAndRestore();
    harness.advanceDays(1);
    claimAndRestore();
    harness.advanceDays(29);

    expect(() => receive()).not.toThrow();
    expect(harness.profiles.find(PROFILE)?.context.state).toBe('잠정_사용_제한');
  });
});

describe('Requirement 26.36 — the owner\'s objection becomes an operator review item', () => {
  beforeEach(() => {
    harness.consent.recordCloneConsent({
      kind: 'clone',
      submitterId: OWNER,
      submittedAtMs: harness.clock.now().getTime(),
      isSpeaker: true,
      hasExplicitPermission: false,
      prohibitedUseConfirmation: true,
      speakerRelationship: '본인',
      targetProfileId: PROFILE,
    });
    receive();
  });

  it('hands the operator the consent record and the objection together', () => {
    const reviewItemId = harness.withdrawal.submitObjection({
      voiceProfileId: PROFILE,
      ownerId: OWNER,
      objection: '제출자는 화자가 아닙니다.',
    });

    expect(harness.operatorReview.items).toHaveLength(1);
    expect(harness.operatorReview.items[0]).toMatchObject({
      reviewItemId,
      voiceProfileId: PROFILE,
      withdrawalClaimId: 'wd-1',
      ownerId: OWNER,
      objection: '제출자는 화자가 아닙니다.',
    });
    expect(harness.operatorReview.items[0]?.consentRecords).toHaveLength(1);
  });

  it('audits the objection without copying the objection text into the append-only log', () => {
    harness.withdrawal.submitObjection({
      voiceProfileId: PROFILE,
      ownerId: OWNER,
      objection: 'sensitive free text',
    });
    const draft = harness.auditOf('consent_withdrawal_objection')[0];

    expect(draft).toMatchObject({
      actorId: OWNER,
      targetId: PROFILE,
      afterValue: { withdrawalClaimId: 'wd-1', consentRecordCount: 1 },
    });
    expect(JSON.stringify(draft?.afterValue)).not.toContain('sensitive free text');
  });

  it('does not lift the restriction — an operator decides', () => {
    harness.withdrawal.submitObjection({
      voiceProfileId: PROFILE,
      ownerId: OWNER,
      objection: '이의',
    });

    expect(harness.profiles.find(PROFILE)?.context.state).toBe('잠정_사용_제한');
    expect(harness.access.isUsable(PROFILE, OWNER)).toBe(false);
  });

  it('still accepts an objection after the withdrawal completed', () => {
    harness.identity.setVerdict('verified');
    harness.withdrawal.submitIdentityEvidence(PROFILE, {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    harness.withdrawal.submitObjection({
      voiceProfileId: PROFILE,
      ownerId: OWNER,
      objection: '이의',
    });

    expect(harness.operatorReview.items[0]?.withdrawalClaimId).toBe('wd-1');
  });

  it('refuses an objection when the profile is not restricted at all', () => {
    harness.advanceDays(14);
    harness.withdrawal.expireVerification(PROFILE);

    const error = refusal(() =>
      harness.withdrawal.submitObjection({
        voiceProfileId: PROFILE,
        ownerId: OWNER,
        objection: '이의',
      }),
    );

    expect(error.statusCode).toBe(409);
    expect(harness.operatorReview.items).toEqual([]);
  });
});
