import { describe, expect, it } from 'vitest';

import {
  SFX_DEFAULT_TARGET_LENGTH_SECONDS,
  SFX_DEFAULT_VARIANT_COUNT,
  SFX_GUIDANCE_SCALE_DEFAULT,
  SFX_PROMPT_MAX_TOKENS,
} from '../../../domain/sfx/bounds';
import { stepBoundsFor, usesDistilledModel } from '../../../domain/sfx/model-tier';
import { countPromptTokens } from '../../../domain/sfx/tokenize';
import { validateSfxRequest } from '../../../domain/sfx/validation';

/**
 * Sound-effect request validation.
 *
 * **Validates: Requirements 22.2, 22.3, 22.4, 22.5, 22.9, 22.10, 22.11, 22.12, 22.13, 22.17, 22.18**
 */

function violationFields(request: Parameters<typeof validateSfxRequest>[0]): readonly string[] {
  const result = validateSfxRequest(request);
  return result.kind === 'invalid' ? result.violations.map((violation) => violation.field) : [];
}

describe('the prompt (Requirements 22.2, 22.3)', () => {
  it('accepts a one-character prompt', () => {
    expect(validateSfxRequest({ prompt: 'x' }).kind).toBe('valid');
  });

  it('rejects a prompt that is only whitespace, measuring after trimming', () => {
    const result = validateSfxRequest({ prompt: '   \n\t ' });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.prompt?.constraint).toBe('min_length');
    // Requirement 22.3 asks for the character count, and it is the trimmed one.
    expect(result.prompt?.characterCount).toBe(0);
    expect(result.violations.map((violation) => violation.field)).toEqual(['prompt']);
  });

  it('rejects a prompt over the token ceiling and reports both counts', () => {
    // 100 four-letter words estimate to 100 tokens, comfortably over 77.
    const prompt = Array.from({ length: 100 }, () => 'door').join(' ');
    const result = validateSfxRequest({ prompt });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.prompt?.constraint).toBe('max_tokens');
    expect(result.prompt?.tokenCount).toBe(countPromptTokens(prompt));
    expect(result.prompt?.tokenCount).toBeGreaterThan(SFX_PROMPT_MAX_TOKENS);
    expect(result.prompt?.characterCount).toBe(prompt.length);
    expect(result.prompt?.maxTokens).toBe(SFX_PROMPT_MAX_TOKENS);
  });

  it('stores the prompt trimmed, so the engine sees what was validated', () => {
    const result = validateSfxRequest({ prompt: '  a glass shatters  ' });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.prompt).toBe('a glass shatters');
  });

  it('accepts a prompt at exactly the token ceiling', () => {
    // Each single character is one token under the estimate, so 77 of them is the boundary.
    const prompt = Array.from({ length: SFX_PROMPT_MAX_TOKENS }, () => 'a').join(' ');

    expect(countPromptTokens(prompt)).toBe(SFX_PROMPT_MAX_TOKENS);
    expect(validateSfxRequest({ prompt }).kind).toBe('valid');
  });

  it('counts punctuation separately from the word beside it', () => {
    expect(countPromptTokens('door, slam')).toBe(countPromptTokens('door slam') + 1);
  });
});

describe('target length and variant count (Requirements 22.4, 22.5, 22.18)', () => {
  it.each([0.1, 2.0, 10.0])('accepts %s seconds', (targetLengthSeconds) => {
    expect(validateSfxRequest({ prompt: 'click', targetLengthSeconds }).kind).toBe('valid');
  });

  it.each([0.09, 10.01, 0, -1, Number.NaN])('rejects %s seconds', (targetLengthSeconds) => {
    expect(violationFields({ prompt: 'click', targetLengthSeconds })).toContain(
      'targetLengthSeconds',
    );
  });

  it.each([1, 4, 8])('accepts %i variants', (variantCount) => {
    expect(validateSfxRequest({ prompt: 'click', variantCount }).kind).toBe('valid');
  });

  it.each([0, 9, 1.5, -1])('rejects %s variants', (variantCount) => {
    expect(violationFields({ prompt: 'click', variantCount })).toContain('variantCount');
  });

  it('reports every violated field at once, not just the first', () => {
    // Requirement 22.18 names both fields; a caller told about one at a time makes two trips.
    expect(violationFields({ prompt: 'click', targetLengthSeconds: 99, variantCount: 99 })).toEqual([
      'targetLengthSeconds',
      'variantCount',
    ]);
  });

  it('reports the permitted range with the rejection', () => {
    const result = validateSfxRequest({ prompt: 'click', targetLengthSeconds: 99 });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]?.allowed).toEqual({
      kind: 'range',
      min: 0.1,
      max: 10.0,
      integer: false,
    });
  });
});

describe('sampling steps are validated per tier (Requirements 22.9, 22.10, 22.11)', () => {
  it('provides exactly two tiers, one distilled and one not', () => {
    expect(usesDistilledModel('fast')).toBe(true);
    expect(usesDistilledModel('high_quality')).toBe(false);
  });

  it.each([1, 4, 8])('accepts %i steps on the fast tier', (samplingSteps) => {
    expect(validateSfxRequest({ prompt: 'click', modelTier: 'fast', samplingSteps }).kind).toBe(
      'valid',
    );
  });

  it.each([0, 9, 30])('rejects %i steps on the fast tier', (samplingSteps) => {
    expect(violationFields({ prompt: 'click', modelTier: 'fast', samplingSteps })).toContain(
      'samplingSteps',
    );
  });

  it.each([8, 30, 100])('accepts %i steps on the high-quality tier', (samplingSteps) => {
    expect(
      validateSfxRequest({ prompt: 'click', modelTier: 'high_quality', samplingSteps }).kind,
    ).toBe('valid');
  });

  it.each([7, 101, 1])('rejects %i steps on the high-quality tier', (samplingSteps) => {
    expect(
      violationFields({ prompt: 'click', modelTier: 'high_quality', samplingSteps }),
    ).toContain('samplingSteps');
  });

  it('is genuinely tier-relative: 4 steps passes fast and fails high quality', () => {
    // The point of Requirements 22.10 and 22.11 being separate criteria: a step count is not
    // valid or invalid on its own.
    expect(validateSfxRequest({ prompt: 'click', modelTier: 'fast', samplingSteps: 4 }).kind).toBe(
      'valid',
    );
    expect(
      validateSfxRequest({ prompt: 'click', modelTier: 'high_quality', samplingSteps: 4 }).kind,
    ).toBe('invalid');
  });

  it('reports the tier-specific range, not a merged one', () => {
    const result = validateSfxRequest({ prompt: 'click', modelTier: 'high_quality', samplingSteps: 1 });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]?.allowed).toEqual({
      kind: 'range',
      min: stepBoundsFor('high_quality').min,
      max: stepBoundsFor('high_quality').max,
      integer: true,
    });
  });

  it('refuses an unknown tier with the two that exist, and does not judge the steps', () => {
    const fields = violationFields({
      prompt: 'click',
      modelTier: 'ultra' as never,
      samplingSteps: 30,
    });

    expect(fields).toEqual(['modelTier']);
  });
});

describe('guidance scale and seed (Requirements 22.12, 22.13)', () => {
  it.each([1.0, 7.5, 15.0])('accepts a guidance scale of %s', (guidanceScale) => {
    expect(validateSfxRequest({ prompt: 'click', guidanceScale }).kind).toBe('valid');
  });

  it.each([0.9, 15.1])('rejects a guidance scale of %s', (guidanceScale) => {
    expect(violationFields({ prompt: 'click', guidanceScale })).toContain('guidanceScale');
  });

  it.each([0, 2_147_483_647])('accepts a seed of %i', (seed) => {
    expect(validateSfxRequest({ prompt: 'click', seed }).kind).toBe('valid');
  });

  it.each([-1, 2_147_483_648, 1.5])('rejects a seed of %s', (seed) => {
    expect(violationFields({ prompt: 'click', seed })).toContain('seed');
  });
});

describe('defaults (Requirement 22.17)', () => {
  it('applies 2.0 s, 4 variants and the fast tier, and says which it applied', () => {
    const result = validateSfxRequest({ prompt: 'click' });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.targetLengthSeconds).toBe(SFX_DEFAULT_TARGET_LENGTH_SECONDS);
    expect(result.parameters.variantCount).toBe(SFX_DEFAULT_VARIANT_COUNT);
    expect(result.parameters.modelTier).toBe('fast');
    expect(result.parameters.guidanceScale).toBe(SFX_GUIDANCE_SCALE_DEFAULT);
    expect(result.parameters.appliedDefaults).toEqual([
      'targetLengthSeconds',
      'variantCount',
      'modelTier',
      'samplingSteps',
      'guidanceScale',
    ]);
  });

  it('defaults the step count from the resolved tier, not from a fixed number', () => {
    const fast = validateSfxRequest({ prompt: 'click', modelTier: 'fast' });
    const high = validateSfxRequest({ prompt: 'click', modelTier: 'high_quality' });

    expect(fast.kind === 'valid' ? fast.parameters.samplingSteps : 0).toBe(8);
    expect(high.kind === 'valid' ? high.parameters.samplingSteps : 0).toBe(30);
  });

  it('records nothing as defaulted when the caller specified everything', () => {
    const result = validateSfxRequest({
      prompt: 'click',
      targetLengthSeconds: 1.5,
      variantCount: 2,
      modelTier: 'high_quality',
      samplingSteps: 20,
      guidanceScale: 3.0,
    });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.appliedDefaults).toEqual([]);
  });

  it('defaults the loop flag to false, so 22.15 is the rule that applies', () => {
    const result = validateSfxRequest({ prompt: 'click' });

    expect(result.kind === 'valid' && result.parameters.loop).toBe(false);
  });
});
