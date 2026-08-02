import { describe, expect, it } from 'vitest';

import { createSpeechHarness, TEST_OWNER_ID } from '../../support/speech-harness';
import { affirmativeCloneConsent } from '../../support/speech-harness';

/**
 * Voice_Profile creation, over task 6.2's real consent machinery.
 *
 * **Validates: Requirements 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.12,
 * 26.13, 26.14, 26.15**
 *
 * The claim these tests exist to establish is the one task 2.7 was told to honour rather than
 * reinvent: **a `cloned` Voice_Profile cannot be created or used without a valid consent record.**
 * The consent record is task 6.2's `ConsentService`, the immutability is 6.2's, the audit entry of
 * 26.15 is 6.2's, and every assertion below goes through them.
 */

describe('a cloned profile needs consent first (Requirements 26.12, 26.13)', () => {
  it('creates the profile when the four items of 26.12 are affirmative', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    expect(profile.kind).toBe('cloned');
    expect(profile.ownerId).toBe(TEST_OWNER_ID);
    // The record exists and points at this profile.
    expect(harness.consent.records.recordsFor(profile.voiceProfileId)).toHaveLength(1);
    // 26.15 — the consent event reached the Audit_Log.
    expect(harness.consent.auditOf('consent_recorded')).toHaveLength(1);
  });

  it('refuses a request with no consent record and discards the uploads (26.13)', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1', 'upload-2'],
      }),
    ).rejects.toMatchObject({
      code: 'voice_consent_incomplete',
      details: { uploadsDiscarded: true, creditsCharged: 0 },
    });

    expect(harness.staging.discarded).toEqual(['upload-1', 'upload-2']);
    // Nothing was persisted, which is 26.13's "영구 저장 없이".
    expect(harness.staging.promoted).toEqual([]);
    expect(harness.profileStore.all).toEqual([]);
  });

  it('refuses when neither the speaker claim nor the permission claim is affirmative', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1'],
        consent: {
          ...affirmativeCloneConsent(),
          isSpeaker: false,
          hasExplicitPermission: false,
          speakerRelationship: '제3자_허가보유',
          speakerIdentity: 'A. Speaker',
          withdrawalContact: 'speaker@example.test',
        },
      }),
    ).rejects.toMatchObject({ code: 'voice_consent_incomplete' });

    expect(harness.staging.discarded).toEqual(['upload-1']);
  });

  it('accepts a third-party record that holds explicit permission and a contact', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.profiles.createCloned({
      ownerId: TEST_OWNER_ID,
      name: 'Third party',
      uploadIds: ['upload-1'],
      consent: {
        submitterId: TEST_OWNER_ID,
        isSpeaker: false,
        hasExplicitPermission: true,
        prohibitedUseConfirmation: true,
        speakerRelationship: '제3자_허가보유',
        speakerIdentity: 'A. Speaker',
        withdrawalContact: 'speaker@example.test',
      },
    });

    expect(profile.consentRecordId).toBeTruthy();
    expect(harness.staging.promoted).toEqual([
      { uploadId: 'upload-1', voiceProfileId: profile.voiceProfileId },
    ]);
  });

  it('refuses a negative prohibited-use confirmation, whatever else is affirmative', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1'],
        consent: { ...affirmativeCloneConsent(), prohibitedUseConfirmation: false },
      }),
    ).rejects.toMatchObject({
      code: 'voice_consent_incomplete',
      details: { unmetItems: ['prohibited_use_confirmation'] },
    });
  });

  it('takes the consent record before the samples are probed at all', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1'],
      }),
    ).rejects.toMatchObject({ code: 'voice_consent_incomplete' });

    // A request with no consent never causes the platform to decode the audio.
    expect(harness.referenceProbe.requests).toEqual([]);
  });
});

describe('the request bounds (Requirements 26.1, 26.7)', () => {
  it('refuses an empty name before anything is stored', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: '   ',
        uploadIds: ['upload-1'],
        consent: affirmativeCloneConsent(),
      }),
    ).rejects.toMatchObject({ code: 'voice_profile_request_invalid' });
    expect(harness.staging.discarded).toEqual(['upload-1']);
  });

  it('refuses zero samples and refuses eleven', async () => {
    const harness = createSpeechHarness();

    for (const uploadIds of [[], Array.from({ length: 11 }, (_v, index) => `u-${String(index)}`)]) {
      await expect(
        harness.profiles.createCloned({
          ownerId: TEST_OWNER_ID,
          name: 'Narrator',
          uploadIds,
          consent: affirmativeCloneConsent(),
        }),
      ).rejects.toMatchObject({ code: 'voice_profile_request_invalid' });
    }
  });

  it('accepts exactly ten samples', async () => {
    const harness = createSpeechHarness();
    const uploadIds = Array.from({ length: 10 }, (_v, index) => `u-${String(index)}`);
    const profile = await harness.profiles.createCloned({
      ownerId: TEST_OWNER_ID,
      name: 'Narrator',
      uploadIds,
      consent: affirmativeCloneConsent(),
    });

    expect(profile.referenceSamples).toHaveLength(10);
  });

  it('refuses an eleventh sample added one at a time (26.7)', async () => {
    const harness = createSpeechHarness();
    const uploadIds = Array.from({ length: 10 }, (_v, index) => `u-${String(index)}`);
    const profile = await harness.profiles.createCloned({
      ownerId: TEST_OWNER_ID,
      name: 'Narrator',
      uploadIds,
      consent: affirmativeCloneConsent(),
    });

    await expect(
      harness.profiles.addReferenceSample({
        voiceProfileId: profile.voiceProfileId,
        uploadId: 'u-extra',
      }),
    ).rejects.toMatchObject({ code: 'voice_profile_request_invalid' });
    expect(harness.staging.discarded).toContain('u-extra');
  });
});

describe('sample validation and the discard (Requirements 26.2\u201326.5)', () => {
  it('refuses a sample outside the bounds and discards every staged upload (26.4)', async () => {
    const harness = createSpeechHarness();
    harness.referenceProbe.setSample('upload-2', { durationMs: 2_000, speechDurationMs: 2_000 });

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1', 'upload-2'],
        consent: affirmativeCloneConsent(),
      }),
    ).rejects.toMatchObject({
      code: 'voice_reference_sample_rejected',
      details: { uploadId: 'upload-2', uploadsDiscarded: true },
    });

    // Every upload is discarded, not only the offending one: a profile built from the subset that
    // passed is not the profile the user asked for.
    expect(harness.staging.discarded).toEqual(['upload-1', 'upload-2']);
    expect(harness.staging.promoted).toEqual([]);
  });

  it('reports the measured speech ratio and the minimum (26.5)', async () => {
    const harness = createSpeechHarness();
    harness.referenceProbe.setSample('upload-1', {
      durationMs: 20_000,
      speechDurationMs: 8_000,
    });

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1'],
        consent: affirmativeCloneConsent(),
      }),
    ).rejects.toMatchObject({
      code: 'voice_reference_sample_rejected',
      details: { measuredSpeechRatio: 0.4, minimumSpeechRatio: 0.6 },
    });
  });

  it('refuses an unreadable upload with its own code', async () => {
    const harness = createSpeechHarness();
    harness.referenceProbe.setUnreadable('upload-1', 'not an audio container');

    await expect(
      harness.profiles.createCloned({
        ownerId: TEST_OWNER_ID,
        name: 'Narrator',
        uploadIds: ['upload-1'],
        consent: affirmativeCloneConsent(),
      }),
    ).rejects.toMatchObject({ code: 'voice_reference_sample_unreadable' });
  });

  it('passes Requirement 30.12\u2019s thresholds to the probe rather than a second copy', async () => {
    const harness = createSpeechHarness();
    await harness.createClonedProfile();

    expect(harness.referenceProbe.requests[0]).toMatchObject({
      speechRmsThresholdDb: -45,
      speechMinDurationMs: 200,
    });
  });
});

describe('the reference text (Requirement 26.6)', () => {
  it('stores a transcript produced by the Transcription_Service', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.setOutput({
      lines: [
        { startMs: 0, endMs: 1_000, text: 'the quick brown fox' },
        { startMs: 1_100, endMs: 2_000, text: 'jumps over' },
      ],
    });
    const profile = await harness.createClonedProfile();

    expect(profile.referenceSamples[0]?.referenceText).toBe('the quick brown fox jumps over');
  });

  it('stores an empty text rather than refusing when the transcriber cannot answer', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.failNext('down', 5);
    const profile = await harness.createClonedProfile();

    // The sample itself passed 26.5, so refusing it because a *different* service was unavailable
    // would discard a valid upload. See the note in `services/voice/profile-service.ts`.
    expect(profile.referenceSamples[0]?.referenceText).toBe('');
  });
});

describe('the combined voice prompt (Requirement 26.8)', () => {
  it('is not built for a single sample', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile({ uploadIds: ['upload-1'] });

    expect(profile.kind === 'cloned' && profile.voicePromptId).toBeNull();
    expect(harness.prompts.calls).toEqual([]);
  });

  it('is built from every sample once there are two or more', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile({
      uploadIds: ['upload-1', 'upload-2', 'upload-3'],
    });

    expect(profile.kind === 'cloned' && profile.voicePromptId).toBe(
      `prompt-${profile.voiceProfileId}-3`,
    );
    expect(harness.prompts.calls[0]?.uploadIds).toEqual(['upload-1', 'upload-2', 'upload-3']);
  });

  it('is recombined when a sample is added', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile({ uploadIds: ['upload-1'] });
    const updated = await harness.profiles.addReferenceSample({
      voiceProfileId: profile.voiceProfileId,
      uploadId: 'upload-2',
    });

    expect(updated.referenceSamples).toHaveLength(2);
    expect(updated.voicePromptId).toBe(`prompt-${profile.voiceProfileId}-2`);
  });
});

describe('a preset profile (Requirements 26.9, 26.10)', () => {
  it('copies the engine and language from the catalogue, never from the caller', () => {
    const harness = createSpeechHarness();
    const profile = harness.profiles.createPreset({
      ownerId: TEST_OWNER_ID,
      name: 'Announcer',
      voiceId: 'b-es-announcer',
    });

    expect(profile.kind).toBe('preset');
    if (profile.kind !== 'preset') return;
    expect(profile.engineId).toBe('tts-engine-b');
    expect(profile.languageCode).toBe('es');
  });

  it('needs no consent record and stores no samples', () => {
    const harness = createSpeechHarness();
    const profile = harness.createPresetProfile();

    expect(harness.consent.records.recordsFor(profile.voiceProfileId)).toEqual([]);
    expect(harness.staging.promoted).toEqual([]);
  });

  it('still gets a consent-state row, so 26.29 and 26.21 apply to it', () => {
    const harness = createSpeechHarness();
    const profile = harness.createPresetProfile();

    expect(harness.consent.access.consentStateOf(profile.voiceProfileId)).toBe('정상');
  });

  it('refuses an unknown catalogue voice, listing the ones that exist (26.9)', () => {
    const harness = createSpeechHarness();

    expect(() =>
      harness.profiles.createPreset({
        ownerId: TEST_OWNER_ID,
        name: 'Nope',
        voiceId: 'not-a-voice',
      }),
    ).toThrowError(/voiceId/);
  });

  it('exposes the catalogue with 26.9\u2019s three fields', () => {
    const harness = createSpeechHarness();
    const catalogue = harness.profiles.presetCatalogue();

    expect(catalogue.length).toBeGreaterThan(0);
    for (const entry of catalogue) {
      expect(entry).toMatchObject({
        voiceId: expect.any(String),
        engineId: expect.any(String),
        languageCode: expect.any(String),
      });
    }
  });
});

describe('lookup', () => {
  it('lists a user\u2019s own profiles and nobody else\u2019s', async () => {
    const harness = createSpeechHarness();
    await harness.createClonedProfile({ ownerId: 'user-1', uploadIds: ['upload-1'] });
    await harness.createClonedProfile({ ownerId: 'user-2', uploadIds: ['upload-2'] });

    expect(harness.profiles.listForOwner('user-1')).toHaveLength(1);
    expect(harness.profiles.listForOwner('user-2')).toHaveLength(1);
    expect(harness.profiles.listForOwner('user-3')).toHaveLength(0);
  });
});
