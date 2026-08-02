import { beforeEach, describe, expect, it } from 'vitest';

import { initialWithdrawalContext } from '../../../domain/voice/withdrawal-machine';
import { ModerationService } from '../../../services/moderation/moderation-service';
import { createRuleBasedPolicyClassifier } from '../../../services/moderation/rule-based-classifier';
import { denyingVoiceConsentLookup } from '../../../services/moderation/voice-consent-port';
import {
  createVoiceConsentHarness,
  type VoiceConsentHarness,
} from '../../support/voice-consent-harness';

/**
 * Task 6.1's `VoiceConsentLookupPort`, implemented by 6.2 (Requirement 16.12).
 *
 * 6.1's report fixed the contract this must honour: `hasUsableConsentRecord` returns
 * **false** for `잠정_사용_제한` and `사용_중지`, so the withdrawal state machine stays in
 * one place and Moderation_Service never re-decides whether a record is still valid. Both
 * states are asserted directly, and the last group runs the real `ModerationService` over
 * the real lookup to show the composition blocks through 16.12's existing path with no
 * change on the moderation side.
 */

const PROFILE = 'voice-1';
const OWNER = 'owner-1';

let harness: VoiceConsentHarness;

beforeEach(() => {
  harness = createVoiceConsentHarness();
  harness.profiles.create({
    voiceProfileId: PROFILE,
    ownerId: OWNER,
    sharedUserIds: ['friend-1'],
  });
});

function recordConsent(targetProfileId = PROFILE): void {
  harness.consent.recordCloneConsent({
    kind: 'clone',
    submitterId: OWNER,
    submittedAtMs: harness.clock.now().getTime(),
    isSpeaker: true,
    hasExplicitPermission: false,
    prohibitedUseConfirmation: true,
    speakerRelationship: '본인',
    targetProfileId,
  });
}

function lookup(submitterId = OWNER): boolean {
  return harness.lookup.hasUsableConsentRecord({ voiceProfileId: PROFILE, submitterId });
}

describe('an affirmative clone record is required', () => {
  it('is false with no record at all', () => {
    expect(lookup()).toBe(false);
  });

  it('is true once an affirmative record exists', () => {
    recordConsent();

    expect(lookup()).toBe(true);
  });

  it('ignores a record targeting a different profile', () => {
    harness.profiles.create({ voiceProfileId: 'voice-2', ownerId: OWNER });
    recordConsent('voice-2');

    expect(lookup()).toBe(false);
  });

  it('does not accept a voice_convert record as a cloning basis', () => {
    // 26.26's two confirmations are about the caller's rights in the source audio; they
    // are not the speaker permission 26.12 requires.
    harness.consent.recordVoiceConvertConsent({
      kind: 'voice_convert',
      submitterId: OWNER,
      submittedAtMs: harness.clock.now().getTime(),
      sourceRightsConfirmation: true,
      prohibitedUseConfirmation: true,
      targetProfileId: PROFILE,
    });

    expect(lookup()).toBe(false);
  });

  it('does not require the submitter to be the one who filed the record', () => {
    // The record is about the speaker's permission; who may generate is 26.18/26.20's
    // share list. Requiring both would refuse a shared profile for everyone except the
    // original uploader.
    recordConsent();

    expect(lookup('friend-1')).toBe(true);
  });
});

describe('6.1\'s contract — the two withdrawal states return false', () => {
  beforeEach(() => {
    recordConsent();
  });

  it('is false in 잠정_사용_제한, even though the record itself is still affirmative', () => {
    harness.withdrawal.receiveWithdrawal({
      voiceProfileId: PROFILE,
      claimantAccountId: null,
      intakeChannel: 'in_product',
    });

    expect(harness.profiles.find(PROFILE)?.context.state).toBe('잠정_사용_제한');
    expect(lookup()).toBe(false);
    expect(lookup('friend-1')).toBe(false);
  });

  it('is false in 사용_중지', () => {
    harness.profiles.create({
      voiceProfileId: PROFILE,
      ownerId: OWNER,
      context: initialWithdrawalContext('사용_중지'),
    });

    expect(lookup()).toBe(false);
  });

  it('is true again after a 26.34 restore', () => {
    harness.withdrawal.receiveWithdrawal({
      voiceProfileId: PROFILE,
      claimantAccountId: null,
      intakeChannel: 'in_product',
    });
    harness.advanceDays(14);
    harness.withdrawal.expireVerification(PROFILE);

    expect(lookup()).toBe(true);
  });

  it('is false for a deleted profile (26.22) and for an unknown one', () => {
    harness.access.deleteProfile(PROFILE, OWNER);

    expect(lookup()).toBe(false);
    expect(harness.lookup.hasUsableConsentRecord({ voiceProfileId: 'nope', submitterId: OWNER }))
      .toBe(false);
  });

  it('is false for a user who is neither owner nor shared (26.20)', () => {
    expect(lookup('stranger')).toBe(false);
  });
});

describe('Requirement 16.12 — through the real Moderation_Service', () => {
  function moderationWith(voiceConsent = harness.lookup): ModerationService {
    return new ModerationService({
      classifier: createRuleBasedPolicyClassifier({ figures: [] }),
      clock: harness.clock,
      auditSink: harness.audit,
      voiceConsent,
    });
  }

  const request = {
    accountId: OWNER,
    requestId: 'req-1',
    texts: [],
    voiceReference: { voiceProfileId: PROFILE, uploadIds: ['upload-1'] },
  };

  it('approves a reference upload once 6.2 holds an affirmative record', () => {
    recordConsent();

    expect(moderationWith().inspect(request).outcome).toBe('approved');
  });

  it('blocks the upload while the profile is provisionally restricted', () => {
    recordConsent();
    harness.withdrawal.receiveWithdrawal({
      voiceProfileId: PROFILE,
      claimantAccountId: null,
      intakeChannel: 'in_product',
    });

    const decision = moderationWith().inspect(request);

    expect(decision.outcome).toBe('blocked');
    if (decision.outcome !== 'blocked') return;
    expect(decision.blocks).toContainEqual({
      code: 'voice_consent_missing',
      voiceProfileId: PROFILE,
    });
  });

  it('still fails closed when no consent store is wired at all', () => {
    expect(moderationWith(denyingVoiceConsentLookup).inspect(request).outcome).toBe('blocked');
  });
});
