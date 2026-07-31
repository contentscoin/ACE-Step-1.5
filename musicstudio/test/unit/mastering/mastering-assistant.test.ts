import { describe, expect, it } from 'vitest';

import { TRUE_PEAK_CEILING_DBTP } from '../../../domain/mastering/bounds';
import { fixedThresholdSource } from '../../../domain/quality/threshold-source';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  changeThreshold,
} from '../../../domain/quality/threshold-set';
import { createMasteringAssistant } from '../../../services/mastering/mastering-assistant';
import type { VersionWrite } from '../../../services/mastering/mastering-assistant';
import {
  ASSET_ID,
  ORIGINAL_VERSION_ID,
  OUT_OF_RANGE_SUGGESTION_ITEMS,
  START_LOUDNESS_LUFS,
  VALID_SUGGESTION_ITEMS,
  audioRef,
  compliantCurve,
  createFakeDspPort,
  createFakeSuggestionModel,
  createUnavailableSuggestionModel,
  measurement,
  originalVersions,
} from '../../support/mastering-harness';

/**
 * `Mastering_Assistant`.
 *
 * **Validates: Requirements 30.1, 30.2, 30.4, 30.5, 30.6, 30.7, 30.9, 30.10, 30.11, 30.12,
 * 30.16, 30.17, 30.21, 30.22, 30.24, 30.25, 30.26, 34.6**
 *
 * The audio behaviour lives in `dsp/test/test_mastering.py`, over real buffers. What is
 * tested here is the *product-layer* half: which requests are refused before any work is
 * queued, which results are refused after the worker has returned, that a refusal creates no
 * version, and that the threshold-set version travels onto everything admitted.
 *
 * The refusal-after-return tests are the ones that could not be written any other way. Each
 * one needs the worker to have produced a specific non-compliant number, and no real input
 * makes the real worker do that — which is exactly why the DSP seam is a port. See
 * `test/support/mastering-harness.ts`.
 */

const SUBJECT = { assetId: ASSET_ID, versionId: ORIGINAL_VERSION_ID };
const SOURCE = audioRef();

function write(overrides: Partial<VersionWrite> = {}): VersionWrite {
  return {
    versions: originalVersions(),
    newVersionId: 'version-mastered-1',
    name: 'Mastered',
    createdAtMs: 1_000,
    ...overrides,
  };
}

function assistant(
  overrides: Partial<Parameters<typeof createMasteringAssistant>[0]> = {},
) {
  return createMasteringAssistant({
    dsp: createFakeDspPort(),
    thresholds: fixedThresholdSource(),
    ...overrides,
  });
}

describe('Requirement 30.26 — an out-of-range request is refused and creates no version', () => {
  it('refuses a loudness target outside the range, before touching the port', async () => {
    const dsp = createFakeDspPort();
    const outcome = await assistant({ dsp }).normaliseLoudness(
      { subject: SUBJECT, targetLufs: -40 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('parameter_out_of_range');
    expect(outcome.violations?.[0]?.field).toBe('targetLufs');
    // Nothing was queued: 30.26's synchronous refusal is only possible if validation
    // precedes the port.
    expect(dsp.calls.normalise).toHaveLength(0);
  });

  it('refuses every out-of-range ducking parameter at once', async () => {
    const dsp = createFakeDspPort();
    const outcome = await assistant({ dsp }).duck(
      {
        dialogueSubject: SUBJECT,
        musicSubject: SUBJECT,
        depthDb: -40,
        attackMs: 5,
        releaseMs: 9_000,
      },
      SOURCE,
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations?.map((violation) => violation.field)).toEqual([
      'depthDb',
      'attackMs',
      'releaseMs',
    ]);
    expect(dsp.calls.ducking).toHaveLength(0);
  });
});

describe('Requirements 30.5, 30.6 — normalisation', () => {
  it('reaches the target and reports both measurements rounded to 0.1', async () => {
    const outcome = await assistant().normaliseLoudness(
      { subject: SUBJECT, targetLufs: -16 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.after.integratedLoudnessLufs).toBe(-16);
    // Requirement 30.24: the reported values sit on the 0.1 step.
    for (const value of [outcome.before.integratedLoudnessLufs, outcome.before.truePeakDbtp]) {
      expect(Math.abs(value * 10 - Math.round(value * 10))).toBeLessThan(1e-9);
    }
  });

  it('applies Requirement 30.5\u2019s default and says it did', async () => {
    const dsp = createFakeDspPort();
    const outcome = await assistant({ dsp }).normaliseLoudness({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.parameters).toEqual({ targetLufs: -14, appliedDefaults: ['targetLufs'] });
    expect(dsp.calls.normalise[0]?.targetLufs).toBe(-14);
  });

  it('refuses audio with no gating block above the -70 LUFS absolute gate', async () => {
    // Requirement 30.6's precondition. Refused rather than silently returning the input,
    // because a user who asked for -14 LUFS and got their file back unchanged could not tell
    // that from a normalisation that needed no gain.
    const dsp = createFakeDspPort({ normalise: { measurable: false } });

    const outcome = await assistant({ dsp }).normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('not_measurable');
  });

  it('records the threshold-set version the run was judged against (34.6)', async () => {
    const change = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'loudness_normalization_target_tolerance_lufs',
      1.5,
    );
    if (change.kind !== 'applied') throw new Error('expected the change to apply');

    const outcome = await assistant({
      thresholds: fixedThresholdSource(change.set),
    }).normaliseLoudness({ subject: SUBJECT, targetLufs: -14 }, SOURCE, write());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.qualityThresholdSetVersion).toBe(change.set.version);
  });
});

describe('Requirement 30.7 — the true-peak ceiling is verified, not assumed', () => {
  it('refuses a result whose reported peak exceeds the ceiling', async () => {
    const dsp = createFakeDspPort({
      normalise: {
        output: audioRef(),
        before: measurement(),
        after: measurement({ integratedLoudnessLufs: -14, truePeakDbtp: -0.4 }),
        appliedGainDb: 4.3,
        targetMissed: false,
        measurable: true,
      },
    });

    const outcome = await assistant({ dsp }).normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('true_peak_ceiling_exceeded');
    expect(outcome.bound).toBe(TRUE_PEAK_CEILING_DBTP);
    expect(outcome.measured).toBe(-0.4);
  });

  it('accepts a peak that rounds to the ceiling exactly', async () => {
    // Requirement 30.24 defines the true peak as the value rounded to 0.1, so an unrounded
    // -0.96 dBTP reports as -1.0 and must not fail a ceiling it reports as meeting.
    const dsp = createFakeDspPort({
      normalise: {
        output: audioRef(),
        before: measurement(),
        after: measurement({ integratedLoudnessLufs: -14, truePeakDbtp: -0.96 }),
        appliedGainDb: 1,
        targetMissed: false,
        measurable: true,
      },
    });

    const outcome = await assistant({ dsp }).normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
  });
});

describe('Requirement 30.25 — a missed target is reported, not hidden', () => {
  it('reports the shortfall and preserves the input version', async () => {
    const dsp = createFakeDspPort({
      normalise: {
        output: audioRef({ objectKey: 'audio/limited.flac' }),
        before: measurement({ integratedLoudnessLufs: START_LOUDNESS_LUFS, truePeakDbtp: -1.2 }),
        after: measurement({ integratedLoudnessLufs: -18.1, truePeakDbtp: -1.0 }),
        appliedGainDb: 0.2,
        targetMissed: true,
        measurable: true,
      },
    });

    const outcome = await assistant({ dsp }).normaliseLoudness(
      { subject: SUBJECT, targetLufs: -8 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.targetMissed).toBe(true);
    expect(outcome.shortfallLufs).toBeCloseTo(-8 - -18.1, 9);
    // Requirements 30.4, 30.25: the input is still named and the original version survives.
    expect(outcome.input).toBe(SOURCE);
    expect(outcome.versions.find((version) => version.id === ORIGINAL_VERSION_ID)).toEqual(
      originalVersions()[0],
    );
  });

  it('reports no shortfall for a result inside the tolerance band', async () => {
    const outcome = await assistant().normaliseLoudness(
      { subject: SUBJECT, targetLufs: -16 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.targetMissed).toBe(false);
    expect(outcome.shortfallLufs).toBe(0);
  });

  it('treats a result outside the tolerance as missed even if the worker did not say so', async () => {
    // The service judges, the worker measures. A worker that reported `targetMissed: false`
    // for a result 3 LUFS away would otherwise have its claim taken at face value.
    const dsp = createFakeDspPort({
      normalise: {
        output: audioRef(),
        before: measurement(),
        after: measurement({ integratedLoudnessLufs: -17, truePeakDbtp: -2 }),
        appliedGainDb: 1.3,
        targetMissed: false,
        measurable: true,
      },
    });

    const outcome = await assistant({ dsp }).normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.targetMissed).toBe(true);
  });
});

describe('Requirements 30.9, 30.10, 30.11 — dialogue cleanup', () => {
  it('sends the speech rule and the attenuation from the threshold set in force', async () => {
    const dsp = createFakeDspPort();
    await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(dsp.calls.cleanup[0]).toMatchObject({
      speechRmsThresholdDb: -45,
      speechMinDurationMs: 200,
      nonSpeechAttenuationDb: 10,
    });
  });

  it('produces a new version and preserves the original (30.11)', async () => {
    const outcome = await assistant().cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.versions).toHaveLength(2);
    expect(outcome.created.derivedFromVersionId).toBe(ORIGINAL_VERSION_ID);
    expect(outcome.created.isOriginal).toBe(false);
    expect(outcome.versions[0]).toEqual(originalVersions()[0]);
  });

  it('refuses a cleanup that did not attenuate the non-speech sections enough', async () => {
    const dsp = createFakeDspPort({
      cleanup: { nonSpeechRmsBeforeDb: -40, nonSpeechRmsAfterDb: -46 },
    });

    const outcome = await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('non_speech_attenuation_insufficient');
    expect(outcome.measured).toBeCloseTo(6, 9);
    expect(outcome.bound).toBe(10);
  });

  it('refuses a cleanup that moved the speech loudness too far', async () => {
    const dsp = createFakeDspPort({
      cleanup: { speechLoudnessBeforeLufs: -16.2, speechLoudnessAfterLufs: -18.0 },
    });

    const outcome = await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('speech_loudness_moved');
    expect(outcome.bound).toBe(1);
  });

  it('refuses a cleanup that changed the length (30.10)', async () => {
    const dsp = createFakeDspPort({
      cleanup: { inputDurationMs: 3_000, outputDurationMs: 3_012 },
    });

    const outcome = await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('length_not_preserved');
    expect(outcome.measured).toBeCloseTo(12, 9);
  });

  it('skips the attenuation check for audio that is speech end to end', async () => {
    // Requirement 30.9's first clause has no 발화 구간이 아닌 구간 to be about. Skipped
    // explicitly rather than passing because `NaN < bound` happens to be false.
    const dsp = createFakeDspPort({
      cleanup: {
        hasNonSpeech: false,
        nonSpeechRmsBeforeDb: Number.NEGATIVE_INFINITY,
        nonSpeechRmsAfterDb: Number.NEGATIVE_INFINITY,
      },
    });

    const outcome = await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(true);
  });

  it('skips the speech-loudness check for audio with no speech in it', async () => {
    const dsp = createFakeDspPort({
      cleanup: {
        speechRegions: [],
        speechLoudnessBeforeLufs: Number.NEGATIVE_INFINITY,
        speechLoudnessAfterLufs: Number.NEGATIVE_INFINITY,
      },
    });

    const outcome = await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.speechLoudnessDeltaLufs).toBe(0);
  });

  it('creates no version on a refusal', async () => {
    // Requirement 30.26's rule, which applies to every refusal path: nothing is stored.
    const dsp = createFakeDspPort({
      cleanup: { inputDurationMs: 3_000, outputDurationMs: 4_000 },
    });
    const versions = originalVersions();

    await assistant({ dsp }).cleanDialogue({ subject: SUBJECT }, SOURCE, write({ versions }));

    expect(versions).toHaveLength(1);
  });
});

describe('Requirements 30.12–30.17 — auto-ducking', () => {
  it('attenuates the music track and never returns the dialogue track', async () => {
    const dialogue = audioRef({ objectKey: 'audio/dialogue.flac' });
    const music = audioRef({ objectKey: 'audio/music.flac' });

    const outcome = await assistant().duck(
      { dialogueSubject: SUBJECT, musicSubject: SUBJECT },
      dialogue,
      music,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The *music* track is the input reported, because it is the one processed.
    expect(outcome.input).toBe(music);
  });

  it('stores the curve the worker applied (30.17)', async () => {
    const outcome = await assistant().duck(
      { dialogueSubject: SUBJECT, musicSubject: SUBJECT },
      SOURCE,
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.automation.points.length).toBeGreaterThan(1);
    expect(outcome.automation.speechRegions).toEqual([{ startMs: 1_000, endMs: 1_500 }]);
    expect(outcome.automation.depthDb).toBe(-12);
  });

  it('applies all three defaults and names them', async () => {
    const outcome = await assistant().duck(
      { dialogueSubject: SUBJECT, musicSubject: SUBJECT },
      SOURCE,
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.parameters).toEqual({
      depthDb: -12,
      attackMs: 50,
      releaseMs: 300,
      appliedDefaults: ['depthDb', 'attackMs', 'releaseMs'],
    });
  });

  it('refuses a curve that leaves a speech region under-ducked (30.12)', async () => {
    const dsp = createFakeDspPort({
      ducking: {
        output: audioRef(),
        speechRegions: [{ startMs: 1_000, endMs: 1_500 }],
        // An attack that starts at the region instead of ending there.
        automationPoints: [
          { timeMs: 0, gainDb: 0 },
          { timeMs: 1_000, gainDb: 0 },
          { timeMs: 1_400, gainDb: -12 },
          { timeMs: 1_500, gainDb: -12 },
          { timeMs: 1_800, gainDb: 0 },
          { timeMs: 3_000, gainDb: 0 },
        ],
        durationMs: 3_000,
      },
    });

    const outcome = await assistant({ dsp }).duck(
      { dialogueSubject: SUBJECT, musicSubject: SUBJECT },
      SOURCE,
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ducking_curve_invalid');
    expect(outcome.automationDefects?.[0]).toMatchObject({
      kind: 'speech_region_under_ducked',
    });
  });

  it('refuses a curve that never returns the bed to unity (30.16)', async () => {
    const dsp = createFakeDspPort({
      ducking: {
        output: audioRef(),
        speechRegions: [{ startMs: 1_000, endMs: 1_500 }],
        automationPoints: [
          { timeMs: 0, gainDb: -4 },
          { timeMs: 950, gainDb: -4 },
          { timeMs: 1_000, gainDb: -12 },
          { timeMs: 1_500, gainDb: -12 },
          { timeMs: 1_800, gainDb: -4 },
          { timeMs: 3_000, gainDb: -4 },
        ],
        durationMs: 3_000,
      },
    });

    const outcome = await assistant({ dsp }).duck(
      { dialogueSubject: SUBJECT, musicSubject: SUBJECT },
      SOURCE,
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.automationDefects?.[0]).toMatchObject({ kind: 'non_speech_level_moved' });
  });

  it('accepts a compliant curve at a non-default depth', async () => {
    const regions = [{ startMs: 400, endMs: 900 }];
    const dsp = createFakeDspPort({
      ducking: {
        output: audioRef(),
        speechRegions: regions,
        automationPoints: compliantCurve(regions, 2_000, -6, 120, 600),
        durationMs: 2_000,
      },
    });

    const outcome = await assistant({ dsp }).duck(
      {
        dialogueSubject: SUBJECT,
        musicSubject: SUBJECT,
        depthDb: -6,
        attackMs: 120,
        releaseMs: 600,
      },
      SOURCE,
      SOURCE,
      write(),
    );

    expect(outcome.ok).toBe(true);
  });
});

describe('Requirements 30.19–30.23 — the suggestion', () => {
  it('returns a model suggestion with the measurements (30.1, 30.22)', async () => {
    const outcome = await assistant({
      suggestionModel: createFakeSuggestionModel(VALID_SUGGESTION_ITEMS),
    }).suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.suggestion.source).toBe('model');
    expect(outcome.suggestion.engineId).toBe('deepafx-mastering-v1');
    expect(outcome.reported.octaveBands).toHaveLength(10);
  });

  it('carries the model\u2019s commercial-use ruling onto the suggestion (30.23)', async () => {
    const outcome = await assistant({
      suggestionModel: createFakeSuggestionModel(VALID_SUGGESTION_ITEMS, {
        commercialUseAllowed: false,
      }),
    }).suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The value folds into `resolveCommercialUseOnWrite`'s conjunction; nothing here can
    // widen it.
    expect(outcome.suggestion.commercialUseAllowed).toBe(false);
  });

  it('falls back to the built-in preset when the service is unavailable (30.20, 30.21)', async () => {
    const outcome = await assistant({
      suggestionModel: createUnavailableSuggestionModel(new Error('timed out')),
    }).suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.suggestion.source).toBe('builtin');
    expect(outcome.suggestion.engineId).toBeNull();
  });

  it('falls back when no suggestion service is configured at all', async () => {
    // An operator who has not deployed it is in exactly the state 30.21 describes, so this
    // is a fallback rather than a configuration error.
    const outcome = await assistant().suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.suggestion.source).toBe('builtin');
  });

  it('falls back when the model answers with an out-of-range chain (30.2)', async () => {
    // A service answering with something unusable is, for this clause, unavailable. Clamping
    // the model's numbers into range would return values it did not choose while still
    // labelling them a model suggestion.
    const outcome = await assistant({
      suggestionModel: createFakeSuggestionModel(OUT_OF_RANGE_SUGGESTION_ITEMS),
    }).suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.suggestion.source).toBe('builtin');
  });

  it('falls back when the model answers with something that is not a chain', async () => {
    const outcome = await assistant({
      suggestionModel: createFakeSuggestionModel({ nonsense: true }),
    }).suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.suggestion.source).toBe('builtin');
  });

  it('still reports the measurements when it falls back (30.22)', async () => {
    // The fallback replaces the suggestion, not the analysis.
    const dsp = createFakeDspPort();
    const outcome = await assistant({
      dsp,
      suggestionModel: createUnavailableSuggestionModel(new Error('down')),
    }).suggest(SOURCE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(dsp.calls.analyse).toHaveLength(1);
    expect(outcome.reported.integratedLoudnessLufs).toBe(START_LOUDNESS_LUFS);
  });

  it('analyses before it asks the model, so an unreachable model costs no report', async () => {
    const dsp = createFakeDspPort();
    await assistant({
      dsp,
      suggestionModel: createUnavailableSuggestionModel(new Error('down')),
    }).suggest(SOURCE);

    expect(dsp.calls.analyse).toHaveLength(1);
  });
});

describe('Requirement 30.18 — nothing here is a source of non-determinism', () => {
  it('produces identical results for identical inputs', async () => {
    // Identifiers and the timestamp arrive as arguments, so two calls with the same
    // arguments cannot differ. A service that minted a UUID or read a clock could not make
    // this claim.
    const first = await assistant().normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write(),
    );
    const second = await assistant().normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write(),
    );

    expect(first).toEqual(second);
  });
});

describe('Requirement 29.19 — the version cap still applies', () => {
  it('refuses when the asset already holds sixteen versions', async () => {
    const versions = [
      originalVersions()[0]!,
      ...Array.from({ length: 15 }, (_unused, index) => ({
        id: `version-${String(index)}`,
        assetId: ASSET_ID,
        name: `V${String(index)}`,
        effectChain: null,
        derivedFromVersionId: ORIGINAL_VERSION_ID,
        isOriginal: false,
        isDefault: false,
        durationMs: 3_000,
        createdAtMs: 1,
      })),
    ];

    const outcome = await assistant().normaliseLoudness(
      { subject: SUBJECT, targetLufs: -14 },
      SOURCE,
      write({ versions }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('version_limit_reached');
    expect(outcome.versionRefusal?.limit).toBe(16);
  });
});
