import { beforeEach, describe, expect, it } from 'vitest';

import { RESPONSIBLE_USE_GUIDE_PATH } from '../../../services/voice/responsible-use';
import { isVoiceError } from '../../../services/voice/errors';
import {
  createVoiceConsentHarness,
  VOICE_HARNESS_BASE_URL,
  type VoiceConsentHarness,
} from '../../support/voice-consent-harness';

/**
 * Voice_Consent_Record intake (Requirements 26.12–26.15, 26.26, 26.27).
 *
 * The ordering rule is the one that needs a test rather than a reading: 26.12 requires
 * the record "참조 샘플 영구 저장 이전 단계에서", and 26.13 requires the upload to be
 * discarded without permanent storage when the check fails. So a refusal must tell the
 * caller to discard, and it must store nothing — both asserted below.
 */

let harness: VoiceConsentHarness;

beforeEach(() => {
  harness = createVoiceConsentHarness();
  harness.profiles.create({ voiceProfileId: 'voice-1', ownerId: 'owner-1' });
});

function cloneDraft(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'clone' as const,
    submitterId: 'owner-1',
    submittedAtMs: harness.clock.now().getTime(),
    isSpeaker: true,
    hasExplicitPermission: false,
    prohibitedUseConfirmation: true,
    speakerRelationship: '본인' as const,
    targetProfileId: 'voice-1',
    ...overrides,
  };
}

describe('Requirements 26.12, 26.15 — an accepted clone record', () => {
  it('stores the record and audits the event', () => {
    const intake = harness.consent.recordCloneConsent(cloneDraft());

    expect(intake.outcome).toBe('recorded');
    expect(harness.records.all).toHaveLength(1);
    expect(harness.auditOf('consent_recorded')).toHaveLength(1);
    expect(harness.auditOf('consent_recorded')[0]).toMatchObject({
      actorId: 'owner-1',
      targetId: 'voice-1',
      afterValue: { consentRecordKind: 'clone', immutable: true },
    });
  });

  it('stamps the audit entry from the injected clock, not the wall clock', () => {
    harness.consent.recordCloneConsent(cloneDraft());

    expect(harness.auditOf('consent_recorded')[0]?.eventTime).toEqual(harness.clock.now());
  });

  it('finds the record by profile', () => {
    harness.consent.recordCloneConsent(cloneDraft());

    expect(harness.consent.recordsFor('voice-1')).toHaveLength(1);
    expect(harness.consent.recordsFor('voice-2')).toEqual([]);
  });
});

describe('Requirement 26.13 — a refusal stores nothing and discards the upload', () => {
  it('names the unmet items and tells the caller to discard', () => {
    const intake = harness.consent.recordCloneConsent(
      cloneDraft({
        isSpeaker: false,
        hasExplicitPermission: false,
        speakerRelationship: '제3자_허가보유',
        speakerIdentity: '이서준',
        withdrawalContact: 'withdraw@example.com',
      }),
    );

    expect(intake).toEqual({
      outcome: 'rejected',
      unmetItems: ['is_speaker', 'has_explicit_permission'],
      discardUploads: true,
    });
  });

  it('writes neither a record nor an audit entry', () => {
    harness.consent.recordCloneConsent(cloneDraft({ prohibitedUseConfirmation: false }));

    expect(harness.records.all).toEqual([]);
    expect(harness.auditOf('consent_recorded')).toEqual([]);
  });

  it('treats an absent record the same way, naming 26.12\'s four items', () => {
    const intake = harness.consent.recordCloneConsent(undefined);

    expect(intake).toEqual({
      outcome: 'rejected',
      unmetItems: [
        'is_speaker',
        'has_explicit_permission',
        'prohibited_use_confirmation',
        'speaker_relationship',
      ],
      discardUploads: true,
    });
  });

  it('raises a 422 with the unmet items on the HTTP-facing form', () => {
    try {
      harness.consent.requireCloneConsent(undefined);
      expect.unreachable('requireCloneConsent must throw');
    } catch (error) {
      expect(isVoiceError(error)).toBe(true);
      if (!isVoiceError(error)) return;
      expect(error.statusCode).toBe(422);
      expect(error.code).toBe('voice_consent_incomplete');
      // 26.26 requires the balance to be unchanged; the response says so rather than
      // leaving a client to infer it from a separate balance call.
      expect(error.details).toMatchObject({ creditsCharged: 0 });
    }
  });
});

describe('Requirement 26.26 — the two conversion confirmations are a precondition', () => {
  const convertDraft = {
    kind: 'voice_convert' as const,
    submitterId: 'owner-1',
    submittedAtMs: 0,
    sourceRightsConfirmation: true,
    prohibitedUseConfirmation: true,
    targetProfileId: 'voice-1',
  };

  it('records both confirmations', () => {
    const intake = harness.consent.recordVoiceConvertConsent({
      ...convertDraft,
      submittedAtMs: harness.clock.now().getTime(),
    });

    expect(intake.outcome).toBe('recorded');
    expect(harness.auditOf('consent_recorded')[0]).toMatchObject({
      afterValue: { consentRecordKind: 'voice_convert' },
    });
  });

  it('refuses a missing source-rights confirmation and charges nothing', () => {
    const intake = harness.consent.recordVoiceConvertConsent({
      ...convertDraft,
      sourceRightsConfirmation: false,
    });

    expect(intake).toMatchObject({
      outcome: 'rejected',
      unmetItems: ['source_rights_confirmation'],
      discardUploads: true,
    });
    expect(harness.records.all).toEqual([]);
  });

  it('refuses an absent record with both item names', () => {
    expect(harness.consent.recordVoiceConvertConsent(undefined)).toMatchObject({
      unmetItems: ['source_rights_confirmation', 'prohibited_use_confirmation'],
    });
  });
});

describe('Requirement 26.14 — the store has no way to modify a record', () => {
  it('exposes append and read only', () => {
    const keys = Object.keys(harness.records).sort();

    expect(keys).toEqual(['all', 'append', 'recordsFor']);
    expect(keys).not.toContain('update');
  });

  it('keeps every record for a profile rather than replacing the previous one', () => {
    harness.consent.recordCloneConsent(cloneDraft());
    harness.consent.recordCloneConsent(cloneDraft({ prohibitedUseConfirmation: true }));

    expect(harness.consent.recordsFor('voice-1')).toHaveLength(2);
  });
});

describe('Requirement 26.27 — responsible-use guidance in one action', () => {
  it('returns an absolute URL, so no client assembles one of its own', () => {
    expect(harness.consent.guidance().guideUrl).toBe(
      `${VOICE_HARNESS_BASE_URL}${RESPONSIBLE_USE_GUIDE_PATH}`,
    );
  });

  it('carries the six prohibited uses inline, which is what makes one action enough', () => {
    const guidance = harness.consent.guidance();

    expect(guidance.prohibitedUses).toHaveLength(6);
    expect(guidance.prohibitedUses.map((entry) => entry.label)).toContain('사칭');
  });

  it('states the withdrawal windows the procedure depends on', () => {
    expect(harness.consent.guidance()).toMatchObject({
      withdrawalIntakeHours: 24,
      identityVerificationDays: 14,
    });
  });
});
