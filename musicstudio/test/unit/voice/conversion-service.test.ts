import { describe, expect, it } from 'vitest';

import { durationMs as audioDurationMs } from '../../../domain/audio/pcm';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { voiceConversionThresholds } from '../../../domain/quality/speech-thresholds';
import { fixedThresholdSource } from '../../../domain/quality/threshold-source';
import { changeThreshold } from '../../../domain/quality/threshold-set';
import {
  CONTENT_PRESERVATION_BASES,
  contentPreservationClaim,
  evaluateConversionLength,
} from '../../../domain/voice/conversion';
import {
  affirmativeConvertConsent,
  createSpeechHarness,
  sourceUtterance,
  TEST_OWNER_ID,
} from '../../support/speech-harness';

/**
 * Voice conversion.
 *
 * **Validates: Requirements 26.24, 26.25, 26.26, 26.20, 26.22, 26.29, 34.6**
 *
 * ### What these tests do and do not establish
 *
 * They establish 26.25 completely: the length is measured on both files, the window is read from the
 * Quality_Threshold_Set, a result outside it fails the job and is refunded, and no asset is stored
 * on that path — so a *stored* conversion always satisfies 26.25.
 *
 * They do **not** establish 26.24's content preservation, and no test here claims to. Deciding that
 * two recordings say the same words needs a model this environment does not have. What is asserted
 * instead is that the claim's *basis* is recorded on the asset as `port_contract`, so a reader can
 * tell an asserted guarantee from a measured one. See `domain/voice/conversion.ts` and the task
 * report.
 */

const LENGTH = voiceConversionThresholds(INITIAL_QUALITY_THRESHOLD_SET);

async function convertible(harness: ReturnType<typeof createSpeechHarness>, sourceMs = 4_000) {
  const profile = await harness.createClonedProfile();
  harness.sourceUtterances.set('asset-src', sourceUtterance(sourceMs));
  return profile;
}

describe('the tolerance is a Quality_Threshold_Set member (Requirements 26.25, 34.3)', () => {
  it('is ±100 ms initially', () => {
    expect(LENGTH.lengthToleranceMs).toBe(100);
  });

  it('includes the boundary, because 26.25 says "이내"', () => {
    for (const errorMs of [-100, 0, 100]) {
      expect(
        evaluateConversionLength(
          { sourceDurationMs: 5_000, outputDurationMs: 5_000 + errorMs },
          LENGTH,
        ).satisfied,
      ).toBe(true);
    }
    for (const errorMs of [-101, 101]) {
      expect(
        evaluateConversionLength(
          { sourceDurationMs: 5_000, outputDurationMs: 5_000 + errorMs },
          LENGTH,
        ).satisfied,
      ).toBe(false);
    }
  });

  it('reports the signed error, so a caller sees which way it drifted', () => {
    expect(
      evaluateConversionLength({ sourceDurationMs: 5_000, outputDurationMs: 5_300 }, LENGTH).errorMs,
    ).toBe(300);
    expect(
      evaluateConversionLength({ sourceDurationMs: 5_000, outputDurationMs: 4_700 }, LENGTH).errorMs,
    ).toBe(-300);
  });

  it('records the set version it was judged against (34.6)', () => {
    expect(
      evaluateConversionLength({ sourceDurationMs: 1, outputDurationMs: 1 }, LENGTH)
        .qualityThresholdSetVersion,
    ).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });
});

describe('the content-preservation claim (Requirement 26.24)', () => {
  it('offers exactly two bases, only one of which is reachable here', () => {
    expect(CONTENT_PRESERVATION_BASES).toEqual(['port_contract', 'transcript_match']);
  });

  it('carries no similarity for a port-contract claim, because there is no number', () => {
    expect(contentPreservationClaim('port_contract', 0.9)).toEqual({
      basis: 'port_contract',
      similarity: null,
      requirement: '26.24',
    });
  });
});

describe('converting (Requirements 26.24, 26.25, 26.26)', () => {
  it('produces a dialogue asset of the source\u2019s length', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness, 4_000);

    const outcome = await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });

    expect(outcome.kind).toBe('converted');
    if (outcome.kind !== 'converted') return;
    expect(audioDurationMs(outcome.audio)).toBeCloseTo(4_000, 0);
    expect(outcome.metadata.lengthVerdict.satisfied).toBe(true);
    // Requirement 26.24 — the asset is a `dialogue` asset, produced by one job.
    expect(harness.generation.charges.requests[0]?.assetKind).toBe('dialogue');
    expect(harness.generation.charges.requests[0]?.resultCount).toBe(1);
  });

  it('records the claim basis rather than asserting content preservation silently (26.24)', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);

    const outcome = await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });
    if (outcome.kind !== 'converted') throw new Error('expected a conversion');

    expect(outcome.metadata.contentPreservation).toEqual({
      basis: 'port_contract',
      similarity: null,
      requirement: '26.24',
    });
  });

  it('submits the source\u2019s length and audio modality, so pricing and routing are honest', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness, 7_500);

    await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });

    expect(harness.generation.charges.requests[0]?.durationMs).toBe(7_500);
    expect(harness.generation.adapter.submitted).toEqual([]);
  });

  it('uses a preset profile\u2019s bound engine (26.10)', async () => {
    const harness = createSpeechHarness();
    const profile = harness.createPresetProfile({ voiceId: 'b-en-announcer' });
    harness.sourceUtterances.set('asset-src', sourceUtterance(3_000));

    const outcome = await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });

    expect(outcome.kind === 'converted' && outcome.metadata.engineId).toBe('tts-engine-b');
  });

  it('passes the combined voice prompt when the profile has one (26.8)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile({
      uploadIds: ['upload-1', 'upload-2'],
    });
    harness.sourceUtterances.set('asset-src', sourceUtterance(3_000));

    await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });

    expect(harness.conversionEngine.requests[0]?.voicePromptId).toBe(
      `prompt-${profile.voiceProfileId}-2`,
    );
  });
});

describe('the length invariant is enforced, not trusted (Requirement 26.25)', () => {
  it('fails and refunds a conversion outside the window, storing nothing', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness, 4_000);
    harness.conversionEngine.setLengthDeltaMs(400);

    await expect(
      harness.conversion.convert({
        accountId: TEST_OWNER_ID,
        sourceAssetId: 'asset-src',
        voiceProfileId: profile.voiceProfileId,
        consent: affirmativeConvertConsent(),
      }),
    ).rejects.toMatchObject({
      code: 'voice_conversion_length_unmet',
      statusCode: 422,
      details: { toleranceMs: 100 },
    });

    // Refunded once, through the same CreditRefundPort every other refund uses.
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });

  it('accepts a drift inside the window', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness, 4_000);
    harness.conversionEngine.setLengthDeltaMs(80);

    const outcome = await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });

    expect(outcome.kind).toBe('converted');
    if (outcome.kind !== 'converted') return;
    expect(outcome.metadata.lengthVerdict.errorMs).toBeCloseTo(80, 0);
    expect(harness.generation.refunds.requests).toEqual([]);
  });

  it('judges against the operator\u2019s set rather than the initial values (34.4, 34.6)', async () => {
    const change = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'voice_conversion_length_tolerance_ms',
      500,
    );
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    const harness = createSpeechHarness({ thresholds: fixedThresholdSource(change.set) });
    const profile = await convertible(harness, 4_000);
    harness.conversionEngine.setLengthDeltaMs(400);

    const outcome = await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });

    // 400 ms is outside the initial ±100 ms and inside the operator's ±500 ms.
    expect(outcome.kind).toBe('converted');
    if (outcome.kind !== 'converted') return;
    expect(outcome.metadata.qualityThresholdSetVersion).toBe(change.set.version);
  });
});

describe('the consent precondition (Requirement 26.26)', () => {
  it('refuses a request with no consent record, charging nothing', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);

    await expect(
      harness.conversion.convert({
        accountId: TEST_OWNER_ID,
        sourceAssetId: 'asset-src',
        voiceProfileId: profile.voiceProfileId,
      }),
    ).rejects.toMatchObject({
      code: 'voice_consent_incomplete',
      details: {
        unmetItems: ['source_rights_confirmation', 'prohibited_use_confirmation'],
        creditsCharged: 0,
      },
    });

    // The record is a precondition of *creating* the job, so nothing was submitted.
    expect(harness.generation.charges.requests).toHaveLength(0);
    expect(harness.conversionEngine.requests).toEqual([]);
  });

  it('refuses when either confirmation is negative', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);

    for (const consent of [
      { ...affirmativeConvertConsent(), sourceRightsConfirmation: false },
      { ...affirmativeConvertConsent(), prohibitedUseConfirmation: false },
    ]) {
      await expect(
        harness.conversion.convert({
          accountId: TEST_OWNER_ID,
          sourceAssetId: 'asset-src',
          voiceProfileId: profile.voiceProfileId,
          consent,
        }),
      ).rejects.toMatchObject({ code: 'voice_consent_incomplete' });
    }
    expect(harness.generation.charges.requests).toHaveLength(0);
  });

  it('records the consent identifier on the produced asset (26.14)', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);

    const outcome = await harness.conversion.convert({
      accountId: TEST_OWNER_ID,
      sourceAssetId: 'asset-src',
      voiceProfileId: profile.voiceProfileId,
      consent: affirmativeConvertConsent(),
    });
    if (outcome.kind !== 'converted') throw new Error('expected a conversion');

    expect(harness.consent.records.recordsFor(profile.voiceProfileId).map((r) => r.consentRecordId))
      .toContain(outcome.metadata.consentRecordId);
  });
});

describe('the profile gates apply to conversion too', () => {
  it('refuses a stranger (26.20)', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);

    await expect(
      harness.conversion.convert({
        accountId: 'stranger',
        sourceAssetId: 'asset-src',
        voiceProfileId: profile.voiceProfileId,
        consent: affirmativeConvertConsent('stranger'),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'voice_profile_forbidden' });
  });

  it('refuses a withdrawn profile with a reason code (26.29)', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);
    harness.consent.withdrawal.receiveWithdrawal({
      voiceProfileId: profile.voiceProfileId,
      intakeChannel: 'in_product',
      claimantAccountId: 'speaker-1',
    });

    await expect(
      harness.conversion.convert({
        accountId: TEST_OWNER_ID,
        sourceAssetId: 'asset-src',
        voiceProfileId: profile.voiceProfileId,
        consent: affirmativeConvertConsent(),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'voice_consent_withdrawn' });
  });

  it('answers 404 for a missing source utterance', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    await expect(
      harness.conversion.convert({
        accountId: TEST_OWNER_ID,
        sourceAssetId: 'nope',
        voiceProfileId: profile.voiceProfileId,
        consent: affirmativeConvertConsent(),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'voice_conversion_source_not_found' });
  });
});

describe('engine failure (Requirement 26.24)', () => {
  it('fails and refunds when the conversion engine produces nothing', async () => {
    const harness = createSpeechHarness();
    const profile = await convertible(harness);
    harness.conversionEngine.failNext();

    await expect(
      harness.conversion.convert({
        accountId: TEST_OWNER_ID,
        sourceAssetId: 'asset-src',
        voiceProfileId: profile.voiceProfileId,
        consent: affirmativeConvertConsent(),
      }),
    ).rejects.toMatchObject({
      code: 'voice_conversion_failed',
      details: { partialAudioStored: false },
    });
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });
});

describe('reproducibility', () => {
  it('converts the same source and seed to the same samples', async () => {
    const bytes = async (): Promise<Buffer> => {
      const harness = createSpeechHarness();
      const profile = await convertible(harness, 3_000);
      const outcome = await harness.conversion.convert({
        accountId: TEST_OWNER_ID,
        sourceAssetId: 'asset-src',
        voiceProfileId: profile.voiceProfileId,
        consent: affirmativeConvertConsent(),
        seed: 555,
      });
      if (outcome.kind !== 'converted') throw new Error('expected a conversion');
      const samples = outcome.audio.channels[0] ?? new Float32Array(0);
      return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    };

    expect((await bytes()).equals(await bytes())).toBe(true);
  });
});
