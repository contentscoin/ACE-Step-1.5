import { describe, expect, it } from 'vitest';

import {
  BGM_INTENSITY_GAP_MAX_LUFS,
  BGM_INTENSITY_GAP_MIN_LUFS,
  BGM_SCENE_DESCRIPTION_MAX_LENGTH,
  BGM_TARGET_LENGTH_SECONDS_MAX,
  BGM_TARGET_LENGTH_SECONDS_MIN,
} from '../../../domain/bgm/bounds';
import { bgmCaption, withIntensityCaption } from '../../../domain/bgm/request';
import {
  validateBgmRequest,
  validateBgmVariantRequest,
} from '../../../domain/bgm/validation';
import type { SongFieldViolation } from '../../../domain/song/violation';

/**
 * Background-music request validation.
 *
 * **Validates: Requirements 21.2, 21.3, 21.4, 21.5, 21.9, 21.11, 21.12**
 *
 * Requirement 21.3 is the reason these assertions look at the violation *payload* and
 * not merely at the fact of rejection: it requires the violated field's name together
 * with that field's permitted minimum and maximum, so a test that only checked
 * `kind === 'invalid'` would pass against an implementation that told the caller
 * nothing actionable.
 */

const scene = 'a quiet rain-soaked street at night';

function violationFor(
  violations: readonly SongFieldViolation[],
  field: string,
): SongFieldViolation {
  const found = violations.find((violation) => violation.field === field);
  if (found === undefined) throw new Error(`no violation for ${field}`);
  return found;
}

function invalid(request: Parameters<typeof validateBgmRequest>[0]) {
  const result = validateBgmRequest(request);
  if (result.kind !== 'invalid') throw new Error('expected the request to be rejected');
  return result.violations;
}

function valid(request: Parameters<typeof validateBgmRequest>[0]) {
  const result = validateBgmRequest(request);
  if (result.kind !== 'valid') {
    throw new Error(`expected the request to be accepted: ${JSON.stringify(result.violations)}`);
  }
  return result.parameters;
}

describe('target length bounds (Requirements 21.2, 21.3)', () => {
  it('accepts both ends of the 5–600 second range', () => {
    for (const seconds of [BGM_TARGET_LENGTH_SECONDS_MIN, 60, BGM_TARGET_LENGTH_SECONDS_MAX]) {
      expect(valid({ sceneDescription: scene, targetLengthSeconds: seconds }).targetLengthSeconds)
        .toBe(seconds);
    }
  });

  it('rejects a length below 5 seconds and names the minimum and maximum', () => {
    const violation = violationFor(
      invalid({ sceneDescription: scene, targetLengthSeconds: 4.9 }),
      'targetLengthSeconds',
    );

    expect(violation.received).toBe(4.9);
    expect(violation.allowed).toMatchObject({
      kind: 'range',
      min: BGM_TARGET_LENGTH_SECONDS_MIN,
      max: BGM_TARGET_LENGTH_SECONDS_MAX,
    });
  });

  it('rejects a length above 600 seconds and names the minimum and maximum', () => {
    const violation = violationFor(
      invalid({ sceneDescription: scene, targetLengthSeconds: 600.1 }),
      'targetLengthSeconds',
    );

    expect(violation.allowed).toMatchObject({
      kind: 'range',
      min: BGM_TARGET_LENGTH_SECONDS_MIN,
      max: BGM_TARGET_LENGTH_SECONDS_MAX,
    });
  });

  it('accepts a non-integer length inside the range', () => {
    // The allowance is marked non-integer, and the check must agree with it: a 7.5
    // second sting is a normal ask.
    expect(valid({ sceneDescription: scene, targetLengthSeconds: 7.5 }).targetLengthSeconds).toBe(
      7.5,
    );
  });
});

describe('scene description bounds (Requirements 21.3, 21.5)', () => {
  it('accepts 1 character and 2000 characters', () => {
    expect(valid({ sceneDescription: 'x', targetLengthSeconds: 30 }).sceneDescription).toBe('x');
    const longest = 'y'.repeat(BGM_SCENE_DESCRIPTION_MAX_LENGTH);
    expect(valid({ sceneDescription: longest, targetLengthSeconds: 30 }).sceneDescription).toBe(
      longest,
    );
  });

  it('rejects an empty description and names the permitted length window', () => {
    const violation = violationFor(
      invalid({ sceneDescription: '', targetLengthSeconds: 30 }),
      'sceneDescription',
    );

    expect(violation.allowed).toEqual({
      kind: 'length',
      minLength: 1,
      maxLength: BGM_SCENE_DESCRIPTION_MAX_LENGTH,
    });
  });

  it('rejects 2001 characters', () => {
    const violation = violationFor(
      invalid({
        sceneDescription: 'z'.repeat(BGM_SCENE_DESCRIPTION_MAX_LENGTH + 1),
        targetLengthSeconds: 30,
      }),
      'sceneDescription',
    );

    expect(violation.allowed).toMatchObject({ maxLength: BGM_SCENE_DESCRIPTION_MAX_LENGTH });
  });

  it('reports every violated field at once, not the first (Requirement 21.3)', () => {
    const violations = invalid({ sceneDescription: '', targetLengthSeconds: 1 });

    expect(violations.map((violation) => violation.field).sort()).toEqual([
      'sceneDescription',
      'targetLengthSeconds',
    ]);
  });
});

describe('instrumental parameters are fixed (Requirement 21.4)', () => {
  it('pins every validated request to instrumental with empty lyrics metadata', () => {
    const parameters = valid({ sceneDescription: scene, targetLengthSeconds: 30 });

    expect(parameters.instrumental).toBe(true);
    expect(parameters.lyricsMetadata).toBe('');
  });

  it('has no field through which a caller could request vocals', () => {
    // The obligation is structural: a request type without a lyrics field cannot carry
    // lyrics, so 21.4 cannot be violated by a caller rather than merely being checked.
    const parameters = valid({ sceneDescription: scene, targetLengthSeconds: 30 });
    expect(Object.keys(parameters)).not.toContain('lyrics');
  });
});

describe('caption composition (Requirement 21.1)', () => {
  it('folds mood, scene and instrumentation into one caption', () => {
    expect(
      bgmCaption({
        mood: 'melancholy',
        sceneDescription: scene,
        instrumentation: ['felt piano', 'cello'],
        targetLengthSeconds: 30,
      }),
    ).toBe(`melancholy, ${scene}, felt piano, cello`);
  });

  it('omits absent and blank parts rather than leaving separators behind', () => {
    expect(
      bgmCaption({
        sceneDescription: scene,
        instrumentation: ['  ', ''],
        targetLengthSeconds: 30,
      }),
    ).toBe(scene);
  });

  it('adds an intensity suffix only when there is a ladder (Requirement 21.9)', () => {
    const parameters = valid({ sceneDescription: scene, targetLengthSeconds: 30 });

    expect(withIntensityCaption(parameters, 1, 1).caption).toBe(parameters.caption);
    expect(withIntensityCaption(parameters, 2, 4).caption).toBe(
      `${parameters.caption}, intensity level 2 of 4`,
    );
  });
});

describe('reference asset pins BPM and key (Requirement 21.12)', () => {
  it('replaces the caller-supplied BPM and key with the reference asset values', () => {
    const parameters = valid({
      sceneDescription: scene,
      targetLengthSeconds: 30,
      bpm: 90,
      keyScale: 'A minor',
      reference: { assetId: 'asset-ref-1', bpm: 128, keyScale: 'F major' },
    });

    expect(parameters.bpm).toBe(128);
    expect(parameters.keyScale).toBe('F major');
    expect(parameters.referenceAssetId).toBe('asset-ref-1');
  });

  it('validates the reference asset key against the supported scales', () => {
    const violation = violationFor(
      invalid({
        sceneDescription: scene,
        targetLengthSeconds: 30,
        reference: { assetId: 'asset-ref-1', bpm: 128, keyScale: 'H diminished' },
      }),
      'keyScale',
    );

    expect(violation.allowed.kind).toBe('enum');
  });

  it('leaves BPM and key absent when neither the caller nor a reference supplies them', () => {
    // Requirement 4.7: an omitted field is an instruction to the engine, so it must not
    // be defaulted here — Requirement 21.17 then judges against what the engine chose.
    const parameters = valid({ sceneDescription: scene, targetLengthSeconds: 30 });

    expect(parameters.bpm).toBeUndefined();
    expect(parameters.keyScale).toBeUndefined();
  });
});

describe('intensity variant requests (Requirements 21.9, 21.11)', () => {
  function variantViolations(request: Parameters<typeof validateBgmVariantRequest>[0]) {
    const result = validateBgmVariantRequest(request);
    if (result.kind !== 'invalid') throw new Error('expected the request to be rejected');
    return result.violations;
  }

  it('accepts a variant count of 1 through 4', () => {
    for (const variantCount of [1, 2, 3, 4]) {
      const result = validateBgmVariantRequest({
        sceneDescription: scene,
        targetLengthSeconds: 30,
        variantCount,
      });
      expect(result.kind).toBe('valid');
    }
  });

  it('rejects a count of 0 or 5 and names the 1–4 range', () => {
    for (const variantCount of [0, 5]) {
      const violation = violationFor(
        variantViolations({ sceneDescription: scene, targetLengthSeconds: 30, variantCount }),
        'variantCount',
      );
      expect(violation.allowed).toMatchObject({ kind: 'range', min: 1, max: 4 });
    }
  });

  it('accepts both ends of the 1.0–6.0 LUFS gap window (Requirement 21.11)', () => {
    for (const intensityGapLufs of [BGM_INTENSITY_GAP_MIN_LUFS, BGM_INTENSITY_GAP_MAX_LUFS]) {
      const result = validateBgmVariantRequest({
        sceneDescription: scene,
        targetLengthSeconds: 30,
        variantCount: 3,
        intensityGapLufs,
      });
      if (result.kind !== 'valid') throw new Error('expected acceptance');
      expect(result.parameters.intensityGapLufs).toBe(intensityGapLufs);
    }
  });

  it('rejects a gap outside 1.0–6.0 LUFS', () => {
    for (const intensityGapLufs of [0.9, 6.1]) {
      const violation = violationFor(
        variantViolations({
          sceneDescription: scene,
          targetLengthSeconds: 30,
          variantCount: 3,
          intensityGapLufs,
        }),
        'intensityGapLufs',
      );
      expect(violation.allowed).toMatchObject({
        kind: 'range',
        min: BGM_INTENSITY_GAP_MIN_LUFS,
        max: BGM_INTENSITY_GAP_MAX_LUFS,
      });
    }
  });

  it('defaults the gap to the midpoint of the permitted window', () => {
    const result = validateBgmVariantRequest({
      sceneDescription: scene,
      targetLengthSeconds: 30,
      variantCount: 4,
    });
    if (result.kind !== 'valid') throw new Error('expected acceptance');

    expect(result.parameters.intensityGapLufs).toBe(
      (BGM_INTENSITY_GAP_MIN_LUFS + BGM_INTENSITY_GAP_MAX_LUFS) / 2,
    );
  });

  it('still applies the 21.2 and 21.5 bounds to a variant request', () => {
    expect(
      variantViolations({
        sceneDescription: '',
        targetLengthSeconds: 601,
        variantCount: 9,
      }).map((violation) => violation.field).sort(),
    ).toEqual(['sceneDescription', 'targetLengthSeconds', 'variantCount']);
  });
});
