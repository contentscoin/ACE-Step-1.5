import { describe, expect, it } from 'vitest';

import {
  ACTING_INSTRUCTION_MAX_LENGTH,
  PITCH_SEMITONES_DEFAULT,
  SCRIPT_MAX_LENGTH,
  SPEAKING_RATE_DEFAULT,
  SPLIT_THRESHOLD_DEFAULT,
} from '../../../domain/speech/bounds';
import {
  enginesSupportingLanguage,
  isLanguageCode,
  languageCatalogue,
  normaliseLanguageCode,
} from '../../../domain/speech/language';
import {
  findParalinguisticTags,
  resolveParalinguisticTags,
} from '../../../domain/speech/paralinguistic';
import {
  DIALOGUE_DURATION_MS_CEILING,
  dialogueReproducibilityKey,
  estimatedDialogueDurationMs,
} from '../../../domain/speech/request';
import { validateDialogueRequest } from '../../../domain/speech/validation';

/**
 * Dialogue request validation, language selection and the tag rules.
 *
 * **Validates: Requirements 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10, 25.18, 25.22**
 */

function request(overrides: Record<string, unknown> = {}) {
  return {
    script: 'A line of dialogue.',
    voiceProfileId: 'vp-1',
    languageCode: 'ko',
    ...overrides,
  };
}

describe('the ranges of 25.4–25.10, refused per 25.22', () => {
  it('accepts a minimal request and records every default', () => {
    const result = validateDialogueRequest(request());

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.speakingRate).toBe(SPEAKING_RATE_DEFAULT);
    expect(result.parameters.pitchSemitones).toBe(PITCH_SEMITONES_DEFAULT);
    expect(result.parameters.splitThresholdChars).toBe(SPLIT_THRESHOLD_DEFAULT);
    expect(result.parameters.appliedDefaults).toEqual([
      'speakingRate',
      'pitchSemitones',
      'splitThresholdChars',
    ]);
  });

  it('names every violated constraint at once, so one round trip fixes them all', () => {
    const result = validateDialogueRequest(
      request({
        script: '',
        speakingRate: 3,
        pitchSemitones: -20,
        actingInstruction: 'x'.repeat(ACTING_INSTRUCTION_MAX_LENGTH + 1),
        splitThresholdChars: 10,
      }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toEqual([
      'script',
      'speakingRate',
      'pitchSemitones',
      'actingInstruction',
      'splitThresholdChars',
    ]);
    // Requirement 25.22 asks for the permitted range, which the allowance carries.
    expect(result.violations.map((violation) => violation.allowed.kind)).toEqual([
      'length',
      'range',
      'range',
      'length',
      'range',
    ]);
  });

  it('accepts both ends of each range', () => {
    for (const speakingRate of [0.5, 2.0]) {
      expect(validateDialogueRequest(request({ speakingRate })).kind).toBe('valid');
    }
    for (const pitchSemitones of [-12, 12]) {
      expect(validateDialogueRequest(request({ pitchSemitones })).kind).toBe('valid');
    }
    for (const splitThresholdChars of [100, 5_000]) {
      expect(validateDialogueRequest(request({ splitThresholdChars })).kind).toBe('valid');
    }
    expect(
      validateDialogueRequest(request({ actingInstruction: 'x'.repeat(200) })).kind,
    ).toBe('valid');
  });

  it('measures the script trimmed, so whitespace alone is refused (25.4)', () => {
    expect(validateDialogueRequest(request({ script: '   \n  ' })).kind).toBe('invalid');
    expect(validateDialogueRequest(request({ script: '  a  ' })).kind).toBe('valid');
  });

  it('refuses a script past 20000 characters', () => {
    const result = validateDialogueRequest(
      request({ script: 'x'.repeat(SCRIPT_MAX_LENGTH + 1) }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toEqual(['script']);
  });

  it('refuses a seed outside the shared seed space', () => {
    expect(validateDialogueRequest(request({ seed: -1 })).kind).toBe('invalid');
    expect(validateDialogueRequest(request({ seed: 2_147_483_648 })).kind).toBe('invalid');
    expect(validateDialogueRequest(request({ seed: 0 })).kind).toBe('valid');
  });

  it('carries a caller-named seed through, and omits it otherwise (25.18)', () => {
    const named = validateDialogueRequest(request({ seed: 99 }));
    const unnamed = validateDialogueRequest(request());

    expect(named.kind === 'valid' && named.parameters.seed).toBe(99);
    expect(unnamed.kind === 'valid' && unnamed.parameters.seed).toBeUndefined();
  });
});

describe('the language code (Requirements 25.3, 27.3)', () => {
  it('accepts two lowercase letters and nothing else', () => {
    expect(isLanguageCode('ko')).toBe(true);
    expect(isLanguageCode('KO')).toBe(false);
    expect(isLanguageCode('kor')).toBe(false);
    expect(isLanguageCode('k')).toBe(false);
    expect(isLanguageCode('k1')).toBe(false);
  });

  it('normalises the casing callers vary on', () => {
    const result = validateDialogueRequest(request({ languageCode: ' EN ' }));

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.languageCode).toBe('en');
    expect(normaliseLanguageCode('JA')).toBe('ja');
  });

  it('refuses a malformed code before any engine is consulted', () => {
    const result = validateDialogueRequest(request({ languageCode: 'korean' }));

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toContain('languageCode');
  });

  it('answers 25.3 with every engine that supports the language', () => {
    const catalogue = [
      { engineId: 'a', languageCodes: ['ko', 'en'] },
      { engineId: 'b', languageCodes: ['en', 'es'] },
    ];

    expect(enginesSupportingLanguage(catalogue, 'en')).toEqual(['a', 'b']);
    expect(enginesSupportingLanguage(catalogue, 'ko')).toEqual(['a']);
    // Empty is a meaningful answer: no engine speaks it.
    expect(enginesSupportingLanguage(catalogue, 'de')).toEqual([]);
  });

  it('presents each engine with its languages sorted, for 25.2', () => {
    expect(languageCatalogue([{ engineId: 'a', languageCodes: ['ko', 'en', 'ja'] }])).toEqual([
      { engineId: 'a', languageCodes: ['en', 'ja', 'ko'] },
    ]);
  });
});

describe('the acting instruction (Requirement 25.7)', () => {
  it('is forwarded only to an engine that supports it', () => {
    const supported = validateDialogueRequest(request({ actingInstruction: 'warmly' }), {
      supportsActingInstruction: true,
    });
    const unsupported = validateDialogueRequest(request({ actingInstruction: 'warmly' }), {
      supportsActingInstruction: false,
    });

    expect(supported.kind === 'valid' && supported.parameters.actingInstruction).toBe('warmly');
    expect(unsupported.kind === 'valid' && unsupported.parameters.actingInstruction).toBeNull();
  });

  it('treats an instruction of whitespace as none', () => {
    const result = validateDialogueRequest(request({ actingInstruction: '   ' }), {
      supportsActingInstruction: true,
    });

    expect(result.kind === 'valid' && result.parameters.actingInstruction).toBeNull();
  });

  it('is length-checked even for an engine that cannot use it (25.22)', () => {
    const result = validateDialogueRequest(
      request({ actingInstruction: 'x'.repeat(201) }),
      { supportsActingInstruction: false },
    );

    expect(result.kind).toBe('invalid');
  });
});

describe('paralinguistic tags (Requirements 25.8, 25.9)', () => {
  it('finds the three tags of 25.8, case-insensitively, with their positions', () => {
    const found = findParalinguisticTags('Ha [laugh] oh [SIGH] ah [gasp]');

    expect(found.map((occurrence) => occurrence.tag)).toEqual(['laugh', 'sigh', 'gasp']);
    expect(found[0]?.startOffset).toBe(3);
    expect(found[0]?.endOffset).toBe(10);
  });

  it('leaves the tags in place for a supporting engine, so 25.8 keeps their position', () => {
    const resolved = resolveParalinguisticTags('Ha [laugh] there.', true);

    expect(resolved.script).toBe('Ha [laugh] there.');
    expect(resolved.removedTags).toEqual([]);
    expect(resolved.retainedTags).toEqual(['laugh']);
  });

  it('removes them for a non-supporting engine and names what was removed (25.9)', () => {
    const resolved = resolveParalinguisticTags('Ha [laugh] there [sigh].', false);

    expect(resolved.script).toBe('Ha  there .');
    expect(resolved.removedTags).toEqual(['laugh', 'sigh']);
  });

  it('de-duplicates the names, because 25.9 asks for names rather than a tally', () => {
    const resolved = resolveParalinguisticTags('[laugh] a [laugh] b [laugh]', false);

    expect(resolved.removedTags).toEqual(['laugh']);
    expect(resolved.script).toBe(' a  b ');
  });

  it('leaves unrecognised bracketed text alone — it is content, not a tag', () => {
    const resolved = resolveParalinguisticTags('[whisper] softly [laugh]', false);

    expect(resolved.script).toBe('[whisper] softly ');
    expect(resolved.removedTags).toEqual(['laugh']);
  });

  it('reaches the resolved parameters through validation', () => {
    const result = validateDialogueRequest(request({ script: 'Hi [gasp] there.' }), {
      supportsParalinguisticTags: false,
    });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.removedTags).toEqual(['gasp']);
    expect(result.parameters.script).toBe('Hi  there.');
    // 25.18's key is about what the user asked for, so the original survives.
    expect(result.parameters.originalScript).toBe('Hi [gasp] there.');
  });
});

describe('the reproducibility key (Requirement 25.18)', () => {
  it('carries exactly the six things 25.18 names', () => {
    const result = validateDialogueRequest(request({ seed: 42, splitThresholdChars: 500 }));
    if (result.kind !== 'valid') throw new Error('expected a valid request');

    const key = dialogueReproducibilityKey(result.parameters, 'tts-engine-a', 42);

    expect(Object.keys(key).sort()).toEqual([
      'engineId',
      'pitchSemitones',
      'script',
      'seed',
      'speakingRate',
      'voiceProfileId',
    ]);
    // Deliberately absent: the split threshold, the language and the acting instruction.
    expect(key).not.toHaveProperty('splitThresholdChars');
  });
});

describe('the declared job duration', () => {
  it('is an upper bound that shrinks as the rate rises', () => {
    const atOne = estimatedDialogueDurationMs('x'.repeat(600), 1);
    const atTwo = estimatedDialogueDurationMs('x'.repeat(600), 2);

    expect(atOne).toBe(100_000);
    expect(atTwo).toBe(50_000);
  });

  it('never falls below the 1000 ms floor a routable request needs', () => {
    expect(estimatedDialogueDurationMs('a', 2)).toBe(1_000);
  });

  it('stays inside the descriptor ceiling for the longest script 25.4 permits', () => {
    // Requirement 19.11's ceiling, and `MAX_OUTPUT_DURATION_MS_MAX` in
    // `adapters/registry/engine-descriptor.ts`. 25.4's longest script at 25.5's slowest rate
    // exceeds it, so the estimate clamps — see the note in `domain/speech/request.ts`.
    expect(estimatedDialogueDurationMs('x'.repeat(SCRIPT_MAX_LENGTH), 0.5)).toBe(
      DIALOGUE_DURATION_MS_CEILING,
    );
    expect(DIALOGUE_DURATION_MS_CEILING).toBe(3_600_000);
  });
});
