import { describe, expect, it } from 'vitest';

import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { speechPresenceThresholds } from '../../../domain/quality/speech-thresholds';
import {
  boundEngineIdOf,
  checkEngineBinding,
  needsCombinedPrompt,
  submissionEngineIdOf,
  validateProfileName,
  validateReferenceSampleCount,
  type ClonedVoiceProfile,
  type PresetVoiceProfile,
} from '../../../domain/voice/profile';
import {
  REFERENCE_SAMPLE_FORMATS,
  REFERENCE_SAMPLE_SPEECH_RATIO_MIN,
  speechRatioOf,
  validateReferenceSample,
  type ProbedReferenceSample,
} from '../../../domain/voice/reference-sample';
import {
  DEFAULT_PRESET_VOICE_CATALOGUE,
  findPresetVoice,
  isWellFormedCatalogue,
  listPresetVoices,
} from '../../../domain/voice/voice-catalogue';

/**
 * Voice_Profile shape, reference-sample validation and the preset catalogue.
 *
 * **Validates: Requirements 26.1, 26.2, 26.3, 26.4, 26.5, 26.7, 26.8, 26.9, 26.10, 26.11**
 */

function probed(overrides: Partial<ProbedReferenceSample> = {}): ProbedReferenceSample {
  return {
    uploadId: 'upload-1',
    format: 'wav',
    durationMs: 30_000,
    sampleRate: 48_000,
    speechDurationMs: 24_000,
    ...overrides,
  };
}

const clonedProfile: ClonedVoiceProfile = {
  kind: 'cloned',
  voiceProfileId: 'vp-1',
  ownerId: 'user-1',
  name: 'Narrator',
  referenceSamples: [],
  voicePromptId: null,
  consentRecordId: 'consent-1',
  createdAtMs: 0,
};

const presetProfile: PresetVoiceProfile = {
  kind: 'preset',
  voiceProfileId: 'vp-2',
  ownerId: 'user-1',
  name: 'Preset',
  voiceId: 'a-ko-narrator',
  engineId: 'tts-engine-a',
  languageCode: 'ko',
  createdAtMs: 0,
};

describe('the profile name (Requirement 26.1)', () => {
  it('accepts 1 to 64 characters, measured and stored trimmed', () => {
    expect(validateProfileName('a')).toEqual({ kind: 'valid', name: 'a' });
    expect(validateProfileName('x'.repeat(64)).kind).toBe('valid');
    expect(validateProfileName('  Narrator  ')).toEqual({ kind: 'valid', name: 'Narrator' });
  });

  it('refuses an empty name, a whitespace name and one past 64 characters', () => {
    for (const name of ['', '   ', 'x'.repeat(65)]) {
      expect(validateProfileName(name).kind).toBe('invalid');
    }
  });
});

describe('the reference sample count (Requirement 26.7)', () => {
  it('accepts 1 to 10 and refuses 0 or 11', () => {
    expect(validateReferenceSampleCount(1).kind).toBe('valid');
    expect(validateReferenceSampleCount(10).kind).toBe('valid');
    expect(validateReferenceSampleCount(0).kind).toBe('invalid');
    expect(validateReferenceSampleCount(11).kind).toBe('invalid');
  });
});

describe('the combined prompt (Requirement 26.8)', () => {
  it('is needed from the second sample onwards, and not before', () => {
    const one = { ...clonedProfile, referenceSamples: [sample('a')] };
    const two = { ...clonedProfile, referenceSamples: [sample('a'), sample('b')] };

    expect(needsCombinedPrompt(clonedProfile)).toBe(false);
    expect(needsCombinedPrompt(one)).toBe(false);
    expect(needsCombinedPrompt(two)).toBe(true);
  });
});

describe('reference sample validation (Requirements 26.2\u201326.5)', () => {
  it('accepts a compliant sample and reports its speech ratio', () => {
    const result = validateReferenceSample(probed());

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.speechRatio).toBeCloseTo(0.8, 6);
  });

  it('accepts both ends of the 6\u2013120 second window (26.2)', () => {
    for (const durationMs of [6_000, 120_000]) {
      expect(
        validateReferenceSample(probed({ durationMs, speechDurationMs: durationMs })).kind,
      ).toBe('valid');
    }
  });

  it('refuses a sample shorter than 6 s or longer than 120 s', () => {
    for (const durationMs of [5_999, 120_001]) {
      const result = validateReferenceSample(probed({ durationMs, speechDurationMs: durationMs }));
      expect(result.kind).toBe('invalid');
      if (result.kind !== 'invalid') continue;
      expect(result.constraints).toContain('duration');
    }
  });

  it('accepts each of the three formats of 26.3, case-insensitively', () => {
    for (const format of REFERENCE_SAMPLE_FORMATS) {
      expect(validateReferenceSample(probed({ format })).kind).toBe('valid');
      expect(validateReferenceSample(probed({ format: format.toUpperCase() })).kind).toBe('valid');
    }
    expect(validateReferenceSample(probed({ format: 'ogg' })).kind).toBe('invalid');
  });

  it('refuses a sample rate below 16000 Hz (26.3)', () => {
    expect(validateReferenceSample(probed({ sampleRate: 16_000 })).kind).toBe('valid');
    const result = validateReferenceSample(probed({ sampleRate: 15_999 }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toContain('sampleRate');
  });

  it('refuses a speech ratio below 60 %, reporting the measured value (26.5)', () => {
    const result = validateReferenceSample(
      probed({ durationMs: 20_000, speechDurationMs: 11_000 }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toContain('speechRatio');
    expect(result.speechRatio).toBeCloseTo(0.55, 6);
  });

  it('accepts exactly 60 %, which 26.5 includes', () => {
    expect(
      validateReferenceSample(probed({ durationMs: 10_000, speechDurationMs: 6_000 })).kind,
    ).toBe('valid');
    expect(REFERENCE_SAMPLE_SPEECH_RATIO_MIN).toBe(0.6);
  });

  it('names every violated constraint at once, so 26.4 needs one round trip', () => {
    const result = validateReferenceSample(
      probed({ durationMs: 1_000, format: 'aac', sampleRate: 8_000, speechDurationMs: 100 }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toEqual(['duration', 'format', 'sampleRate', 'speechRatio']);
  });

  it('clamps the ratio into [0, 1] for a nonsense measurement', () => {
    expect(speechRatioOf(probed({ durationMs: 0, speechDurationMs: 100 }))).toBe(0);
    expect(speechRatioOf(probed({ durationMs: 100, speechDurationMs: 500 }))).toBe(1);
  });

  it('reads Requirement 30.12\u2019s speech thresholds rather than a second definition', () => {
    // The rule is Requirement 30's, so 26.5's numbers come from the Quality_Threshold_Set members
    // that already existed. Asserted here so a future change cannot fork the definition.
    const presence = speechPresenceThresholds(INITIAL_QUALITY_THRESHOLD_SET);

    expect(presence.speechRmsThresholdDb).toBe(-45);
    expect(presence.speechMinDurationMs).toBe(200);
  });
});

describe('the preset catalogue (Requirement 26.9)', () => {
  it('carries the three fields 26.9 names, on every entry', () => {
    expect(isWellFormedCatalogue(DEFAULT_PRESET_VOICE_CATALOGUE)).toBe(true);
    for (const entry of DEFAULT_PRESET_VOICE_CATALOGUE) {
      expect(entry.engineId.length).toBeGreaterThan(0);
      expect(entry.voiceId.length).toBeGreaterThan(0);
      expect(entry.languageCode).toMatch(/^[a-z]{2}$/u);
    }
  });

  it('spans both engines, so 26.11\u2019s refusal is reachable', () => {
    const engines = new Set(DEFAULT_PRESET_VOICE_CATALOGUE.map((entry) => entry.engineId));

    expect(engines.size).toBeGreaterThanOrEqual(2);
  });

  it('rejects a catalogue with a duplicate voice identifier', () => {
    const duplicated = [
      ...DEFAULT_PRESET_VOICE_CATALOGUE,
      DEFAULT_PRESET_VOICE_CATALOGUE[0] as (typeof DEFAULT_PRESET_VOICE_CATALOGUE)[number],
    ];

    expect(isWellFormedCatalogue(duplicated)).toBe(false);
  });

  it('filters by engine and by language', () => {
    expect(
      listPresetVoices(DEFAULT_PRESET_VOICE_CATALOGUE, { engineId: 'tts-engine-b' }).every(
        (entry) => entry.engineId === 'tts-engine-b',
      ),
    ).toBe(true);
    expect(
      listPresetVoices(DEFAULT_PRESET_VOICE_CATALOGUE, { languageCode: 'KO' }).every(
        (entry) => entry.languageCode === 'ko',
      ),
    ).toBe(true);
  });

  it('resolves a voice identifier to its entry', () => {
    expect(findPresetVoice(DEFAULT_PRESET_VOICE_CATALOGUE, 'a-ko-narrator')?.engineId).toBe(
      'tts-engine-a',
    );
    expect(findPresetVoice(DEFAULT_PRESET_VOICE_CATALOGUE, 'nope')).toBeUndefined();
  });
});

describe('the engine binding (Requirements 26.10, 26.11)', () => {
  it('binds a preset profile and leaves a clone unbound', () => {
    expect(boundEngineIdOf(presetProfile)).toBe('tts-engine-a');
    expect(boundEngineIdOf(clonedProfile)).toBeNull();
  });

  it('permits the bound engine and an omitted engine, refusing anything else', () => {
    expect(checkEngineBinding(presetProfile, 'tts-engine-a')).toEqual({ outcome: 'permitted' });
    expect(checkEngineBinding(presetProfile, undefined)).toEqual({ outcome: 'permitted' });
    expect(checkEngineBinding(presetProfile, 'tts-engine-b')).toEqual({
      outcome: 'refused',
      boundEngineId: 'tts-engine-a',
      requestedEngineId: 'tts-engine-b',
    });
  });

  it('permits any engine for a cloned profile', () => {
    for (const engineId of [undefined, 'tts-engine-a', 'tts-engine-b']) {
      expect(checkEngineBinding(clonedProfile, engineId).outcome).toBe('permitted');
    }
  });

  it('resolves the engine a submission must use', () => {
    // A preset's binding wins over whatever the caller named.
    expect(submissionEngineIdOf(presetProfile, 'tts-engine-b')).toBe('tts-engine-a');
    // A clone falls back to the caller's engine, or to routing when there is none.
    expect(submissionEngineIdOf(clonedProfile, 'tts-engine-b')).toBe('tts-engine-b');
    expect(submissionEngineIdOf(clonedProfile)).toBeUndefined();
  });
});

function sample(uploadId: string) {
  return {
    uploadId,
    durationMs: 30_000,
    sampleRate: 48_000,
    format: 'wav',
    referenceText: 'hello',
  };
}
