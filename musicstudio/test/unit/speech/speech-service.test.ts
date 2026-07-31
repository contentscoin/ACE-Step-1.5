import { describe, expect, it } from 'vitest';

import { durationMs as audioDurationMs, frameCount } from '../../../domain/audio/pcm';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { dialogueTailSilenceThresholds } from '../../../domain/quality/speech-thresholds';
import { variantSeed } from '../../../domain/sfx/seed';
import { isValidDialogueTiming } from '../../../domain/speech/line-timing';
import { isGenerationError } from '../../../services/generation/errors';
import {
  createSpeechHarness,
  dialogueRequest,
  TEST_DIALOGUE_BASE_SEED,
  TEST_OWNER_ID,
  type SpeechHarness,
} from '../../support/speech-harness';

/**
 * Speech_Service, end to end over the real job lifecycle and the real TTS adapters.
 *
 * **Validates: Requirements 25.1, 25.2, 25.3, 25.9, 25.11, 25.14, 25.15, 25.16, 25.17, 25.18,
 * 25.19, 25.20, 25.21, 25.22, 25.23, 26.10, 26.11, 26.20, 26.22, 26.29, 27.14**
 *
 * Two of these are task 2.7's acceptance criteria and are asserted directly:
 *
 * - **"스크립트 분할·접합 행 순서 보존"** — the split round trip and the line order surviving the
 *   join, below and property-tested in `test/property/dialogue-generation.test.ts`.
 * - **"행 재생성 후 선행 행 타이밍 불변"** — `resynthesiseLine` leaving every preceding line's
 *   timing and *samples* untouched, below and property-tested there too.
 */

const TAIL = dialogueTailSilenceThresholds(INITIAL_QUALITY_THRESHOLD_SET);

async function producedDialogue(
  harness: SpeechHarness,
  overrides: Record<string, unknown> = {},
) {
  const profile = await harness.createClonedProfile();
  const outcome = await harness.speech.generate({
    accountId: TEST_OWNER_ID,
    request: dialogueRequest(profile.voiceProfileId, overrides),
  });
  if (outcome.kind !== 'produced') throw new Error('expected a produced dialogue');
  return { profile, outcome };
}

describe('the produced asset (Requirements 25.1, 25.23, 27.14)', () => {
  it('creates one Generation_Job producing one dialogue asset', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness);

    // One job, not one per line: Requirement 25.1 asks for a Generation_Job producing the asset.
    expect(harness.generation.charges.requests).toHaveLength(1);
    expect(harness.generation.charges.requests[0]?.assetKind).toBe('dialogue');
    expect(harness.generation.charges.requests[0]?.resultCount).toBe(1);
    expect(outcome.jobId).toBe(harness.generation.charges.requests[0]?.jobId);
  });

  it('records the Voice_Profile identifier as provenance (25.23)', async () => {
    const harness = createSpeechHarness();
    const { profile, outcome } = await producedDialogue(harness);

    expect(outcome.metadata.voiceProfileId).toBe(profile.voiceProfileId);
  });

  it('stores the script line boundaries as the asset timing source (27.14)', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness);

    expect(outcome.metadata.timing).toEqual(outcome.timing);
    expect(outcome.timing.lines.map((line) => line.text)).toEqual([
      'First line of dialogue.',
      'Second line of dialogue.',
    ]);
    // The rendition holds the same timings, so there is one source rather than two.
    const rendition = await harness.renditions.find(outcome.assetId);
    expect(rendition?.timing).toEqual(outcome.timing);
  });

  it('records the Quality_Threshold_Set version (34.6)', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness);

    expect(outcome.metadata.qualityThresholdSetVersion).toBe(
      INITIAL_QUALITY_THRESHOLD_SET.version,
    );
  });
});

describe('two engines and their languages (Requirements 25.2, 25.3)', () => {
  it('presents at least two engines, each with its supported languages', () => {
    const harness = createSpeechHarness();
    const catalogue = harness.speech.engineLanguages();

    expect(catalogue.length).toBeGreaterThanOrEqual(2);
    for (const entry of catalogue) {
      expect(entry.languageCodes.length).toBeGreaterThan(0);
    }
    // Both are genuinely registered engines, not a list: routing selects from the registry.
    for (const entry of catalogue) {
      expect(harness.generation.registry.find(entry.engineId)).toBeDefined();
    }
  });

  it('refuses a language the named engine cannot speak, listing the ones that can (25.3)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    // Engine B does not speak `ja`; engine A does.
    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, {
          languageCode: 'ja',
          engineId: 'tts-engine-b',
        }),
      }),
    ).rejects.toMatchObject({
      code: 'dialogue_language_unsupported',
      details: { supportingEngineIds: ['tts-engine-a'], creditsCharged: 0 },
    });

    // Nothing was charged.
    expect(harness.generation.charges.requests).toHaveLength(0);
  });

  it('answers with an empty engine list when no engine speaks the language', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, { languageCode: 'de' }),
      }),
    ).rejects.toMatchObject({
      code: 'dialogue_language_unsupported',
      details: { supportingEngineIds: [] },
    });
  });

  it('routes an unspecified engine to one that speaks the language', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    const outcome = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      // Only engine B speaks `es`.
      request: dialogueRequest(profile.voiceProfileId, { languageCode: 'es' }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.engineId).toBe('tts-engine-b');
  });

  it('prefers the default engine when it speaks the language', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    // Both engines speak `ko`.
    const outcome = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      request: dialogueRequest(profile.voiceProfileId, { languageCode: 'ko' }),
    });

    expect(outcome.kind === 'produced' && outcome.engineId).toBe('tts-engine-a');
  });
});

describe('the preset engine binding (Requirements 26.10, 26.11)', () => {
  it('refuses a preset profile used with an engine it is not bound to', async () => {
    const harness = createSpeechHarness();
    // `a-ko-narrator` is bound to engine A.
    const profile = harness.createPresetProfile({ voiceId: 'a-ko-narrator' });

    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, { engineId: 'tts-engine-b' }),
      }),
    ).rejects.toMatchObject({
      code: 'voice_profile_engine_locked',
      details: { boundEngineId: 'tts-engine-a', creditsCharged: 0 },
    });
    expect(harness.generation.charges.requests).toHaveLength(0);
  });

  it('uses the bound engine when the caller names none', async () => {
    const harness = createSpeechHarness();
    const profile = harness.createPresetProfile({ voiceId: 'b-ko-announcer' });
    const outcome = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      request: dialogueRequest(profile.voiceProfileId),
    });

    expect(outcome.kind === 'produced' && outcome.engineId).toBe('tts-engine-b');
  });

  it('leaves a cloned profile free to use either engine', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    for (const engineId of ['tts-engine-a', 'tts-engine-b']) {
      const outcome = await harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, { engineId, languageCode: 'ko' }),
      });
      expect(outcome.kind === 'produced' && outcome.engineId).toBe(engineId);
    }
  });
});

describe('the consent gate is task 6.2\u2019s, consumed rather than repeated', () => {
  it('refuses a user who is neither owner nor on the share list (26.20 \u2014 403)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    await expect(
      harness.speech.generate({
        accountId: 'stranger',
        request: dialogueRequest(profile.voiceProfileId),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'voice_profile_forbidden' });
    expect(harness.generation.charges.requests).toHaveLength(0);
  });

  it('answers 404 for a deleted profile (26.22)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    harness.consent.access.deleteProfile(profile.voiceProfileId, TEST_OWNER_ID);

    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'voice_profile_not_found' });
  });

  it('refuses a provisionally restricted profile with a withdrawal reason code (26.29)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    harness.consent.withdrawal.receiveWithdrawal({
      voiceProfileId: profile.voiceProfileId,
      intakeChannel: 'in_product',
      claimantAccountId: 'speaker-1',
    });

    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'voice_consent_withdrawn',
      details: {
        withdrawalReasonCode: 'consent_withdrawal_pending_verification',
        creditsCharged: 0,
      },
    });
    expect(harness.generation.charges.requests).toHaveLength(0);
  });
});

describe('splitting and splicing (Requirements 25.11, 25.14, 25.17)', () => {
  it('synthesises one piece per line and joins them in order', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, {
      script: 'One.\nTwo.\nThree.',
    });

    expect(harness.synthesis.requests.map((request) => request.lineIndex)).toEqual([0, 1, 2]);
    expect(harness.synthesis.requests.map((request) => request.text)).toEqual([
      'One.',
      'Two.',
      'Three.',
    ]);
    expect(outcome.timing.lines.map((line) => line.text)).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('reports the chunk count and the sentence count of 25.11/25.13', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, {
      script: 'One.\nTwo.\nThree.',
      splitThresholdChars: 100,
    });

    expect(outcome.chunkCount).toBe(1);
    expect(outcome.sentenceCount).toBeGreaterThanOrEqual(outcome.chunkCount);
    expect(outcome.metadata.chunkCount).toBe(outcome.chunkCount);
  });

  it('joins with the 50 ms cross-fade, so the audio is shorter than the pieces', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, { script: 'One.\nTwo.\nThree.' });

    const rendition = await harness.renditions.find(outcome.assetId);
    const summed = (rendition?.linePieces ?? []).reduce(
      (total, piece) => total + audioDurationMs(piece),
      0,
    );
    // Two seams at 50 ms each.
    expect(audioDurationMs(outcome.audio)).toBeCloseTo(summed - 100, 1);
    expect(outcome.metadata.seamOverlapsMs).toEqual([50, 50]);
  });

  it('satisfies every timing invariant of 25.17', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, {
      script: 'A.\nBb.\nCcc.\nDddd.\nEeeee.',
    });

    expect(isValidDialogueTiming(outcome.timing)).toBe(true);
    expect(outcome.timing.lines.at(-1)?.endMs).toBeLessThanOrEqual(outcome.timing.totalDurationMs);
  });

  it('refuses a script with no storable line list (25.14)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, { script: `${'x'.repeat(1_500)}` }),
      }),
    ).rejects.toMatchObject({
      code: 'dialogue_lines_invalid',
      details: { creditsCharged: 0 },
    });
    expect(harness.generation.charges.requests).toHaveLength(0);
  });
});

describe('the tail silence (Requirement 25.19)', () => {
  it('lands the trailing silence inside the 50\u2013200 ms window', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness);

    expect(outcome.metadata.trailingSilenceMs).toBeGreaterThanOrEqual(TAIL.tailSilenceMinMs);
    expect(outcome.metadata.trailingSilenceMs).toBeLessThanOrEqual(TAIL.tailSilenceMaxMs);
  });

  it('pads a short tail rather than refusing the asset', async () => {
    const harness = createSpeechHarness();
    // The simulator appends 10 ms, well below the 50 ms floor.
    harness.transports.get('tts-engine-a')?.setTailSilenceMs(5);
    const { outcome } = await producedDialogue(harness);

    expect(outcome.tailSilence.satisfied).toBe(false);
    expect(outcome.tailSilence.adjustmentMs).toBeGreaterThan(0);
    expect(outcome.metadata.trailingSilenceMs).toBeGreaterThanOrEqual(TAIL.tailSilenceMinMs);
  });

  it('trims an over-long tail', async () => {
    const harness = createSpeechHarness();
    harness.transports.get('tts-engine-a')?.setTailSilenceMs(900);
    const { outcome } = await producedDialogue(harness);

    expect(outcome.tailSilence.adjustmentMs).toBeLessThan(0);
    expect(outcome.metadata.trailingSilenceMs).toBeLessThanOrEqual(TAIL.tailSilenceMaxMs);
  });
});

describe('single-line re-synthesis (Requirements 25.15, 25.16, 25.20, 25.21)', () => {
  it('leaves every preceding line\u2019s timing unchanged \u2014 task 2.7\u2019s acceptance criterion', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, { script: 'One.\nTwo.\nThree.\nFour.' });
    const before = outcome.timing.lines;

    const resynthesised = await harness.speech.resynthesiseLine({
      accountId: TEST_OWNER_ID,
      assetId: outcome.assetId,
      lineIndex: 2,
    });

    expect(resynthesised.kind).toBe('resynthesised');
    if (resynthesised.kind !== 'resynthesised') return;
    // Lines 0 and 1 are byte-identical.
    expect(resynthesised.timing.lines.slice(0, 2)).toEqual(before.slice(0, 2));
  });

  it('leaves every preceding line\u2019s audio samples unchanged outside the splice (25.15)', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, { script: 'One.\nTwo.\nThree.' });
    const originalRendition = await harness.renditions.find(outcome.assetId);
    const originalPiece = originalRendition?.linePieces[0];

    await harness.speech.resynthesiseLine({
      accountId: TEST_OWNER_ID,
      assetId: outcome.assetId,
      lineIndex: 2,
    });

    const after = await harness.renditions.find(outcome.assetId);
    // Line 0 is not even adjacent to the splice, so its piece is the identical object.
    expect(after?.linePieces[0]).toBe(originalPiece);
    expect(after?.linePieces[1]).toBe(originalRendition?.linePieces[1]);
  });

  it('shifts the successors by the length delta and updates the total (25.16)', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness, { script: 'Short.\nAlso short.\nEnd.' });
    const before = outcome.timing;

    // A much longer replacement, so the delta is unmistakable.
    harness.synthesis.script({
      kind: 'audio',
      audio: harness.transports.get('tts-engine-a')?.pcmFor('tts-a-task-1') ?? outcome.audio,
    });
    const resynthesised = await harness.speech.resynthesiseLine({
      accountId: TEST_OWNER_ID,
      assetId: outcome.assetId,
      lineIndex: 0,
    });
    if (resynthesised.kind !== 'resynthesised') throw new Error('expected a re-synthesis');

    if (resynthesised.retimed) {
      const delta = Math.round(resynthesised.deltaMs);
      expect(resynthesised.timing.lines[1]?.startMs).toBe(
        (before.lines[1]?.startMs ?? 0) + delta,
      );
      expect(resynthesised.timing.lines[2]?.startMs).toBe(
        (before.lines[2]?.startMs ?? 0) + delta,
      );
      expect(resynthesised.timing.totalDurationMs).toBe(before.totalDurationMs + delta);
    }
    expect(isValidDialogueTiming(resynthesised.timing)).toBe(true);
  });

  it('reuses the original profile, engine, rate and pitch (25.15)', async () => {
    const harness = createSpeechHarness();
    const { profile, outcome } = await producedDialogue(harness, {
      speakingRate: 1.5,
      pitchSemitones: -3,
    });
    const requestCountBefore = harness.synthesis.requests.length;

    await harness.speech.resynthesiseLine({
      accountId: TEST_OWNER_ID,
      assetId: outcome.assetId,
      lineIndex: 1,
    });

    const request = harness.synthesis.requests[requestCountBefore];
    expect(request?.parameters.voiceProfileId).toBe(profile.voiceProfileId);
    expect(request?.parameters.speakingRate).toBe(1.5);
    expect(request?.parameters.pitchSemitones).toBe(-3);
    expect(request?.engineId).toBe(outcome.metadata.engineId);
    // The line's own derived seed, so the same line twice is the same audio.
    expect(request?.seed).toBe(variantSeed(outcome.baseSeed, 1));
  });

  it('refuses an out-of-range line index, charging nothing and changing nothing (25.21)', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness);
    const chargesBefore = harness.generation.charges.requests.length;
    const before = await harness.renditions.find(outcome.assetId);

    for (const lineIndex of [-1, 2, 99, 0.5]) {
      await expect(
        harness.speech.resynthesiseLine({
          accountId: TEST_OWNER_ID,
          assetId: outcome.assetId,
          lineIndex,
        }),
      ).rejects.toMatchObject({
        code: 'dialogue_line_index_invalid',
        details: { validFromIndex: 0, validToIndex: 1, timingsUnchanged: true, creditsCharged: 0 },
      });
    }

    expect(harness.generation.charges.requests).toHaveLength(chargesBefore);
    expect(await harness.renditions.find(outcome.assetId)).toEqual(before);
  });

  it('refuses a re-synthesis for a profile withdrawn since the asset was made (26.29)', async () => {
    const harness = createSpeechHarness();
    const { profile, outcome } = await producedDialogue(harness);
    harness.consent.withdrawal.receiveWithdrawal({
      voiceProfileId: profile.voiceProfileId,
      intakeChannel: 'in_product',
      claimantAccountId: 'speaker-1',
    });

    await expect(
      harness.speech.resynthesiseLine({
        accountId: TEST_OWNER_ID,
        assetId: outcome.assetId,
        lineIndex: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'voice_consent_withdrawn' });
  });

  it('answers 404 for an asset it did not produce', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.speech.resynthesiseLine({
        accountId: TEST_OWNER_ID,
        assetId: 'nope',
        lineIndex: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'dialogue_asset_not_found' });
  });
});

describe('the tag removal reaches the response (Requirement 25.9)', () => {
  it('names the removed tags when the engine cannot read them', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    // Engine B supports neither tags nor acting instructions.
    const outcome = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      request: dialogueRequest(profile.voiceProfileId, {
        engineId: 'tts-engine-b',
        script: 'Ha [laugh] there.\nOh [sigh] well.',
      }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.removedTags).toEqual(['laugh', 'sigh']);
    expect(outcome.metadata.removedTags).toEqual(['laugh', 'sigh']);
    // The engine was asked to speak the text without the markers.
    expect(harness.synthesis.requests[0]?.text).not.toContain('[laugh]');
  });

  it('keeps them for an engine that supports them (25.8)', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    const outcome = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      request: dialogueRequest(profile.voiceProfileId, {
        engineId: 'tts-engine-a',
        script: 'Ha [laugh] there.',
      }),
    });

    expect(outcome.kind === 'produced' && outcome.removedTags).toEqual([]);
    expect(harness.synthesis.requests[0]?.text).toContain('[laugh]');
  });
});

describe('failure and the single refund path (Requirement 25.1)', () => {
  it('fails the job and refunds it when a line cannot be synthesised', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();
    harness.synthesis.failLine(1);

    await expect(
      harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, { script: 'One.\nTwo.\nThree.' }),
      }),
    ).rejects.toMatchObject({
      code: 'dialogue_generation_failed',
      details: { completedLineCount: 1, lineCount: 3, partialAudioStored: false },
    });

    // Exactly one refund, through the same CreditRefundPort every other refund uses.
    expect(harness.generation.refunds.requests).toHaveLength(1);
    expect(harness.generation.refunds.requests[0]?.amount).toBe(
      harness.generation.charges.requests[0] === undefined ? 0 : 12,
    );
    // Nothing was stored.
    expect(harness.renditions.all).toEqual([]);
  });
});

describe('reproducibility through the real adapters (Requirement 25.18)', () => {
  it('produces sample-identical audio for the same seed, script, profile, engine, rate and pitch', async () => {
    const run = async (): Promise<Buffer> => {
      const harness = createSpeechHarness();
      const profile = await harness.createClonedProfile();
      const outcome = await harness.speech.generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, {
          seed: 4_242,
          speakingRate: 1.25,
          pitchSemitones: 2,
        }),
      });
      if (outcome.kind !== 'produced') throw new Error('expected a produced dialogue');
      const samples = outcome.audio.channels[0] ?? new Float32Array(0);
      return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    };

    expect((await run()).equals(await run())).toBe(true);
  });

  it('draws and records a seed when the caller names none (25.18\u2019s precondition)', async () => {
    const harness = createSpeechHarness();
    const { outcome } = await producedDialogue(harness);

    expect(outcome.baseSeed).toBe(TEST_DIALOGUE_BASE_SEED);
    expect(outcome.metadata.seed).toBe(TEST_DIALOGUE_BASE_SEED);
    // Each line's seed is derived from the base, so they differ.
    expect(harness.synthesis.requests.map((request) => request.seed)).toEqual([
      variantSeed(TEST_DIALOGUE_BASE_SEED, 0),
      variantSeed(TEST_DIALOGUE_BASE_SEED, 1),
    ]);
  });

  it('changes the audio when the seed changes, so the property is not vacuous', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    const first = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      request: dialogueRequest(profile.voiceProfileId, { seed: 1 }),
    });
    const second = await harness.speech.generate({
      accountId: TEST_OWNER_ID,
      request: dialogueRequest(profile.voiceProfileId, { seed: 2 }),
    });
    if (first.kind !== 'produced' || second.kind !== 'produced') {
      throw new Error('expected two produced dialogues');
    }

    expect(frameCount(first.audio)).toBe(frameCount(second.audio));
    expect(first.audio.channels[0]?.[100]).not.toBe(second.audio.channels[0]?.[100]);
  });
});

describe('the request refusals charge nothing (Requirement 25.22)', () => {
  it('names every violated constraint and its permitted range', async () => {
    const harness = createSpeechHarness();
    const profile = await harness.createClonedProfile();

    const error = await harness.speech
      .generate({
        accountId: TEST_OWNER_ID,
        request: dialogueRequest(profile.voiceProfileId, {
          speakingRate: 5,
          pitchSemitones: 40,
        }),
      })
      .catch((caught: unknown) => caught);

    expect(isGenerationError(error)).toBe(true);
    if (!isGenerationError(error)) return;
    expect(error.code).toBe('dialogue_request_invalid');
    expect(error.details.constraints).toEqual(['speakingRate', 'pitchSemitones']);
    expect(error.details.requirements).toEqual(['25.5', '25.6']);
    expect(error.details.creditsCharged).toBe(0);
    expect(harness.generation.charges.requests).toHaveLength(0);
  });
});
