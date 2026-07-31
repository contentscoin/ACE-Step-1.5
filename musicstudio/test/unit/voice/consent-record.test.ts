import { describe, expect, it } from 'vitest';

import {
  CLONE_CONSENT_REQUIRED_ITEMS,
  CONSENT_ITEMS,
  SPEAKER_RELATIONSHIPS,
  VOICE_CONVERT_CONSENT_REQUIRED_ITEMS,
  isConsentAccepted,
  isSpeakerRelationship,
  missingConsentRecord,
  validateCloneConsent,
  validateConsent,
  validateVoiceConvertConsent,
  type CloneConsentRecordDraft,
  type VoiceConvertConsentRecordDraft,
} from '../../../domain/voice/consent-record';

/**
 * Voice_Consent_Record rules (Requirements 26.12, 26.13, 26.14, 26.26; design §9.3).
 *
 * The disjunction in 26.13 is the part worth pinning by example rather than by
 * inspection: "화자 본인 여부와 명시적 허가 보유 여부가 **모두** 부정" is a refusal only
 * when *both* are negative, and reading it as a conjunction would refuse every
 * legitimate submission. Both directions are asserted below.
 */

function cloneDraft(overrides: Partial<CloneConsentRecordDraft> = {}): CloneConsentRecordDraft {
  return {
    kind: 'clone',
    submitterId: 'account-1',
    submittedAtMs: 1_700_000_000_000,
    isSpeaker: true,
    hasExplicitPermission: false,
    prohibitedUseConfirmation: true,
    speakerRelationship: '본인',
    targetProfileId: 'voice-1',
    ...overrides,
  };
}

function convertDraft(
  overrides: Partial<VoiceConvertConsentRecordDraft> = {},
): VoiceConvertConsentRecordDraft {
  return {
    kind: 'voice_convert',
    submitterId: 'account-1',
    submittedAtMs: 1_700_000_000_000,
    sourceRightsConfirmation: true,
    prohibitedUseConfirmation: true,
    targetProfileId: 'voice-1',
    ...overrides,
  };
}

describe('design §9.3 — the nine mandatory fields', () => {
  it('carries every field the table names, for a third-party record', () => {
    const draft = cloneDraft({
      speakerRelationship: '제3자_허가보유',
      hasExplicitPermission: true,
      isSpeaker: false,
      speakerIdentity: '김하늘, 성우',
      withdrawalContact: 'withdraw@example.com',
    });

    expect(Object.keys(draft).sort()).toEqual(
      [
        'hasExplicitPermission',
        'isSpeaker',
        'kind',
        'prohibitedUseConfirmation',
        'speakerIdentity',
        'speakerRelationship',
        'submittedAtMs',
        'submitterId',
        'targetProfileId',
        'withdrawalContact',
      ].sort(),
    );
    expect(isConsentAccepted(validateConsent(draft))).toBe(true);
  });

  it('names both speaker relationships design §9.3 defines, and nothing else', () => {
    expect([...SPEAKER_RELATIONSHIPS]).toEqual(['본인', '제3자_허가보유']);
    expect(isSpeakerRelationship('본인')).toBe(true);
    expect(isSpeakerRelationship('제3자')).toBe(false);
    expect(isSpeakerRelationship(undefined)).toBe(false);
  });

  it('draws the required item names from one vocabulary', () => {
    for (const item of [...CLONE_CONSENT_REQUIRED_ITEMS, ...VOICE_CONVERT_CONSENT_REQUIRED_ITEMS]) {
      expect(CONSENT_ITEMS).toContain(item);
    }
  });
});

describe('Requirement 26.13 — the identity basis is a disjunction', () => {
  it('accepts the speaker themselves, who needs no third-party permission', () => {
    expect(validateCloneConsent(cloneDraft({ isSpeaker: true, hasExplicitPermission: false })))
      .toEqual({ outcome: 'accepted' });
  });

  it('accepts a permitted third party, who is not the speaker', () => {
    const validation = validateCloneConsent(
      cloneDraft({
        isSpeaker: false,
        hasExplicitPermission: true,
        speakerRelationship: '제3자_허가보유',
        speakerIdentity: '이서준',
        withdrawalContact: '+82-10-0000-0000',
      }),
    );

    expect(validation).toEqual({ outcome: 'accepted' });
  });

  it('refuses when both are negative, naming both items', () => {
    const validation = validateCloneConsent(
      cloneDraft({
        isSpeaker: false,
        hasExplicitPermission: false,
        speakerRelationship: '제3자_허가보유',
        speakerIdentity: '이서준',
        withdrawalContact: '+82-10-0000-0000',
      }),
    );

    expect(validation).toEqual({
      outcome: 'rejected',
      unmetItems: ['is_speaker', 'has_explicit_permission'],
    });
  });

  it('refuses a negative prohibited-use confirmation on its own', () => {
    const validation = validateCloneConsent(cloneDraft({ prohibitedUseConfirmation: false }));

    expect(validation).toEqual({
      outcome: 'rejected',
      unmetItems: ['prohibited_use_confirmation'],
    });
  });

  it('refuses a 본인 record that denies being the speaker', () => {
    const validation = validateCloneConsent(
      cloneDraft({ isSpeaker: false, hasExplicitPermission: true, speakerRelationship: '본인' }),
    );

    expect(validation).toEqual({ outcome: 'rejected', unmetItems: ['speaker_relationship'] });
  });

  it('reports every unmet item in one response rather than the first', () => {
    const validation = validateCloneConsent(
      cloneDraft({
        isSpeaker: false,
        hasExplicitPermission: false,
        prohibitedUseConfirmation: false,
        speakerRelationship: '제3자_허가보유',
      }),
    );

    expect(validation).toEqual({
      outcome: 'rejected',
      unmetItems: [
        'is_speaker',
        'has_explicit_permission',
        'prohibited_use_confirmation',
        'speaker_identity',
        'withdrawal_contact',
      ],
    });
  });

  it('answers an absent record with the same item names a negative one gets', () => {
    expect(missingConsentRecord('clone')).toEqual({
      outcome: 'rejected',
      unmetItems: [...CLONE_CONSENT_REQUIRED_ITEMS],
    });
  });
});

describe('Requirement 26.14 — a third-party record must stay contactable', () => {
  const thirdParty = {
    isSpeaker: false,
    hasExplicitPermission: true,
    speakerRelationship: '제3자_허가보유',
  } as const;

  it('refuses a record with no speaker identity at all', () => {
    const validation = validateCloneConsent(
      cloneDraft({ ...thirdParty, withdrawalContact: 'withdraw@example.com' }),
    );

    expect(validation).toEqual({ outcome: 'rejected', unmetItems: ['speaker_identity'] });
  });

  it('refuses a whitespace-only speaker identity', () => {
    const validation = validateCloneConsent(
      cloneDraft({
        ...thirdParty,
        speakerIdentity: '   ',
        withdrawalContact: 'withdraw@example.com',
      }),
    );

    expect(validation).toEqual({ outcome: 'rejected', unmetItems: ['speaker_identity'] });
  });

  it('refuses a record with no withdrawal contact — 26.28 would have no route', () => {
    const validation = validateCloneConsent(
      cloneDraft({ ...thirdParty, speakerIdentity: '이서준' }),
    );

    expect(validation).toEqual({ outcome: 'rejected', unmetItems: ['withdrawal_contact'] });
  });

  it('refuses a null withdrawal contact the same way as an absent one', () => {
    const validation = validateCloneConsent(
      cloneDraft({ ...thirdParty, speakerIdentity: '이서준', withdrawalContact: null }),
    );

    expect(validation).toEqual({ outcome: 'rejected', unmetItems: ['withdrawal_contact'] });
  });

  it('does not demand a speaker identity from a 본인 record', () => {
    expect(validateCloneConsent(cloneDraft())).toEqual({ outcome: 'accepted' });
  });
});

describe('Requirement 26.26 — the two conversion confirmations', () => {
  it('accepts both affirmative', () => {
    expect(validateVoiceConvertConsent(convertDraft())).toEqual({ outcome: 'accepted' });
  });

  it.each([
    ['source rights', { sourceRightsConfirmation: false }, ['source_rights_confirmation']],
    ['prohibited use', { prohibitedUseConfirmation: false }, ['prohibited_use_confirmation']],
  ])('refuses a negative %s confirmation', (_label, overrides, expected) => {
    expect(validateVoiceConvertConsent(convertDraft(overrides))).toEqual({
      outcome: 'rejected',
      unmetItems: expected,
    });
  });

  it('names both when both are negative', () => {
    const validation = validateVoiceConvertConsent(
      convertDraft({ sourceRightsConfirmation: false, prohibitedUseConfirmation: false }),
    );

    expect(validation).toEqual({
      outcome: 'rejected',
      unmetItems: ['source_rights_confirmation', 'prohibited_use_confirmation'],
    });
  });

  it('answers an absent record with both item names', () => {
    expect(missingConsentRecord('voice_convert')).toEqual({
      outcome: 'rejected',
      unmetItems: [...VOICE_CONVERT_CONSENT_REQUIRED_ITEMS],
    });
  });

  it('does not apply the clone identity items to a conversion record', () => {
    // 26.26 asks for two confirmations, not four. A conversion is about the *caller's*
    // rights in the source audio, so `is_speaker` has no meaning here.
    expect(VOICE_CONVERT_CONSENT_REQUIRED_ITEMS).not.toContain('is_speaker');
    expect(validateConsent(convertDraft())).toEqual({ outcome: 'accepted' });
  });
});
