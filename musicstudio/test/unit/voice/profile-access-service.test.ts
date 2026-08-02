import { beforeEach, describe, expect, it } from 'vitest';

import { WITHDRAWAL_REASON_CODES } from '../../../domain/voice/consent-state';
import { VOICE_DATA_ERASURE_WINDOW_MS } from '../../../domain/voice/windows';
import { initialWithdrawalContext } from '../../../domain/voice/withdrawal-machine';
import { isVoiceError, type VoiceError } from '../../../services/voice/errors';
import {
  createVoiceConsentHarness,
  type VoiceConsentHarness,
} from '../../support/voice-consent-harness';

/**
 * Voice_Profile use permission, sharing and owner deletion
 * (Requirements 26.18–26.23, 26.29).
 *
 * The check *order* is the substantive claim. The owner is always permitted under 26.18,
 * so if the permission check ran before the withdrawal check the owner could keep
 * generating from a profile whose consent had been withdrawn — the single thing
 * Requirement 26 most clearly forbids. `refuses a withdrawn profile even for the owner`
 * is that assertion.
 */

let harness: VoiceConsentHarness;

beforeEach(() => {
  harness = createVoiceConsentHarness();
  harness.profiles.create({
    voiceProfileId: 'voice-1',
    ownerId: 'owner-1',
    sharedUserIds: ['friend-1'],
  });
});

/** The thrown `VoiceError`, or a failure if the call unexpectedly succeeded. */
function refusal(call: () => unknown): VoiceError {
  try {
    call();
  } catch (error) {
    if (isVoiceError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('Requirements 26.18, 26.20 — who may use a profile', () => {
  it('permits the owner', () => {
    expect(harness.access.assertUsable('voice-1', 'owner-1').ownerId).toBe('owner-1');
    expect(harness.access.isUsable('voice-1', 'owner-1')).toBe(true);
  });

  it('permits a user on the share list', () => {
    expect(harness.access.isUsable('voice-1', 'friend-1')).toBe(true);
  });

  it('26.20 — refuses a non-listed user with 403', () => {
    const error = refusal(() => harness.access.assertUsable('voice-1', 'stranger'));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('voice_profile_forbidden');
    expect(harness.access.isUsable('voice-1', 'stranger')).toBe(false);
  });
});

describe('Requirement 26.29 — a withdrawal refuses generation before permission is read', () => {
  beforeEach(() => {
    harness.withdrawal.receiveWithdrawal({
      voiceProfileId: 'voice-1',
      claimantAccountId: null,
      intakeChannel: 'recorded_contact',
    });
  });

  it('refuses a withdrawn profile even for the owner, with the reason code', () => {
    const error = refusal(() => harness.access.assertUsable('voice-1', 'owner-1'));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('voice_consent_withdrawn');
    expect(error.details).toMatchObject({
      consentState: '잠정_사용_제한',
      withdrawalReasonCode: WITHDRAWAL_REASON_CODES.잠정_사용_제한,
      creditsCharged: 0,
    });
  });

  it('refuses a shared user with the withdrawal code rather than the share-list one', () => {
    expect(refusal(() => harness.access.assertUsable('voice-1', 'friend-1')).code).toBe(
      'voice_consent_withdrawn',
    );
  });

  it('reports the 사용_중지 reason code once verification succeeds', () => {
    harness.identity.setVerdict('verified');
    harness.withdrawal.submitIdentityEvidence('voice-1', {
      withdrawalClaimId: 'wd-1',
      kind: 'identity_document',
      evidenceRef: 'doc-1',
    });

    expect(refusal(() => harness.access.assertUsable('voice-1', 'owner-1')).details).toMatchObject(
      {
        consentState: '사용_중지',
        withdrawalReasonCode: WITHDRAWAL_REASON_CODES.사용_중지,
      },
    );
  });

  it('26.36/26.21 — the owner may still object and still delete while restricted', () => {
    expect(harness.access.assertOwner('voice-1', 'owner-1').ownerId).toBe('owner-1');
    expect(() => harness.access.deleteProfile('voice-1', 'owner-1')).not.toThrow();
  });
});

describe('Requirement 26.19 — the share list', () => {
  it('replaces the list and audits the change', () => {
    const saved = harness.access.setSharedUsers('voice-1', 'owner-1', ['a', 'b', 'b']);

    expect(saved).toEqual(['a', 'b']);
    expect(harness.profiles.find('voice-1')?.sharedUserIds).toEqual(['a', 'b']);
    expect(harness.auditOf('voice_profile_sharing_changed')[0]).toMatchObject({
      actorId: 'owner-1',
      targetId: 'voice-1',
      beforeValue: { sharedUserCount: 1 },
      afterValue: { sharedUserCount: 2 },
    });
  });

  it('refuses a list of 51 with the bound and the received count', () => {
    const proposed = Array.from({ length: 51 }, (_unused, index) => `u-${String(index)}`);
    const error = refusal(() => harness.access.setSharedUsers('voice-1', 'owner-1', proposed));

    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('voice_share_list_invalid');
    expect(error.details).toMatchObject({ violation: 'too_many_users', min: 1, max: 50, received: 51 });
  });

  it('refuses an empty list, which is 26.19\'s lower bound rather than "unshare"', () => {
    expect(refusal(() => harness.access.setSharedUsers('voice-1', 'owner-1', [])).details)
      .toMatchObject({ violation: 'too_few_users' });
  });

  it('clears sharing through its own call, and audits it once', () => {
    harness.access.clearSharedUsers('voice-1', 'owner-1');

    expect(harness.profiles.find('voice-1')?.sharedUserIds).toEqual([]);
    expect(harness.auditOf('voice_profile_sharing_changed')).toHaveLength(1);

    // Already empty: nothing changed, so nothing is recorded.
    harness.access.clearSharedUsers('voice-1', 'owner-1');
    expect(harness.auditOf('voice_profile_sharing_changed')).toHaveLength(1);
  });

  it('refuses a non-owner with the same 403 a non-shared user gets', () => {
    // A non-owner must not learn the profile exists from a distinct status.
    expect(refusal(() => harness.access.setSharedUsers('voice-1', 'friend-1', ['x'])).code).toBe(
      'voice_profile_forbidden',
    );
  });

  it('refuses to put the owner on their own share list', () => {
    expect(
      refusal(() => harness.access.setSharedUsers('voice-1', 'owner-1', ['owner-1'])).details,
    ).toMatchObject({ violation: 'owner_listed' });
  });
});

describe('Requirements 26.21, 26.22, 26.23 — owner deletion', () => {
  it('26.21 — erases reference data within 24 hours of the request', () => {
    const nowMs = harness.clock.now().getTime();
    const result = harness.access.deleteProfile('voice-1', 'owner-1');

    expect(result).toEqual({
      voiceProfileId: 'voice-1',
      deletedAtMs: nowMs,
      erasureDueAtMs: nowMs + VOICE_DATA_ERASURE_WINDOW_MS,
      generatedAssetsPreserved: true,
    });
    expect(harness.erasure.calls).toEqual([
      { voiceProfileId: 'voice-1', dueAtMs: nowMs + VOICE_DATA_ERASURE_WINDOW_MS },
    ]);
  });

  it('26.22 — records the deletion instant and moves the profile to 삭제됨', () => {
    harness.access.deleteProfile('voice-1', 'owner-1');
    const row = harness.profiles.find('voice-1');

    expect(row?.context.state).toBe('삭제됨');
    expect(row?.deletedAtMs).toBe(harness.clock.now().getTime());
  });

  it('26.22 — a deleted profile answers 404, not 403', () => {
    harness.access.deleteProfile('voice-1', 'owner-1');
    const error = refusal(() => harness.access.assertUsable('voice-1', 'owner-1'));

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('voice_profile_not_found');
    expect(harness.access.isUsable('voice-1', 'owner-1')).toBe(false);
  });

  it('26.22 — an unknown profile answers the same 404, so ids cannot be enumerated', () => {
    expect(refusal(() => harness.access.assertUsable('voice-404', 'owner-1')).statusCode).toBe(404);
    expect(harness.access.consentStateOf('voice-404')).toBeNull();
  });

  it('26.23 — audits the deletion and states that generated assets are preserved', () => {
    harness.visibility.publish('voice-1', ['asset-1', 'asset-2']);
    harness.access.deleteProfile('voice-1', 'owner-1');

    expect(harness.auditOf('voice_profile_deleted')[0]).toMatchObject({
      actorId: 'owner-1',
      targetId: 'voice-1',
      beforeValue: { consentState: '정상' },
      afterValue: { consentState: '삭제됨', generatedAssetsPreserved: true },
    });
    // The opposite of 26.33: an owner's deletion never unpublishes their back catalogue.
    expect(harness.visibility.privateCalls).toEqual([]);
    expect(harness.visibility.publicAssetsOf('voice-1')).toEqual(['asset-1', 'asset-2']);
  });

  it('refuses a second deletion with 404 rather than erasing twice', () => {
    harness.access.deleteProfile('voice-1', 'owner-1');

    expect(refusal(() => harness.access.deleteProfile('voice-1', 'owner-1')).statusCode).toBe(404);
    expect(harness.erasure.calls).toHaveLength(1);
  });

  it('refuses deletion by anyone but the owner', () => {
    expect(refusal(() => harness.access.deleteProfile('voice-1', 'friend-1')).statusCode).toBe(403);
    expect(harness.erasure.calls).toEqual([]);
  });
});

describe('consentStateOf', () => {
  it('reports the stored state, and null for an unknown profile', () => {
    expect(harness.access.consentStateOf('voice-1')).toBe('정상');

    harness.profiles.create({
      voiceProfileId: 'voice-2',
      ownerId: 'owner-2',
      context: initialWithdrawalContext('사용_중지'),
    });
    expect(harness.access.consentStateOf('voice-2')).toBe('사용_중지');
  });
});
