import { describe, expect, it } from 'vitest';

import { INSTRUMENTAL_LYRICS } from '../../../domain/song/request';
import { validateSongRequest, type SongValidation } from '../../../domain/song/validation';
import { VALID_KEY_SCALES } from '../../../domain/song/key-scale';
import { ACCEPTED_VOCAL_LANGUAGES } from '../../../domain/song/vocal-language';
import type { SongFieldViolation } from '../../../domain/song/violation';
import type { SongGenerationRequest, SongParameters } from '../../../domain/song/request';

/**
 * Song request validation (Requirements 3.2, 3.5, 3.8, 4.2–4.9).
 *
 * The rejection criteria all demand two things back — the field and what would have
 * been accepted — so the assertions are on the violation payload, not merely on the
 * fact of refusal.
 */

function violationsOf(request: SongGenerationRequest): readonly SongFieldViolation[] {
  const result = validateSongRequest(request);
  if (result.kind === 'valid') throw new Error('expected the request to be rejected');
  return result.violations;
}

function parametersOf(request: SongGenerationRequest): SongParameters {
  const result: SongValidation = validateSongRequest(request);
  if (result.kind === 'invalid') {
    throw new Error(`expected the request to be accepted: ${JSON.stringify(result.violations)}`);
  }
  return result.parameters;
}

function violationFor(
  request: SongGenerationRequest,
  field: string,
): SongFieldViolation {
  const found = violationsOf(request).find((violation) => violation.field === field);
  if (found === undefined) throw new Error(`no violation reported for ${field}`);
  return found;
}

describe('Requirement 3.5 — the description is 1 to 2000 characters', () => {
  it('rejects an empty description and states the allowed length range', () => {
    const violation = violationFor({ mode: 'simple', description: '' }, 'description');

    expect(violation.allowed).toEqual({ kind: 'length', minLength: 1, maxLength: 2_000 });
  });

  it('rejects a description longer than 2000 characters', () => {
    const violation = violationFor({ mode: 'simple', description: 'x'.repeat(2_001) }, 'description');

    expect(violation.received).toBe(2_001);
    expect(violation.allowed).toEqual({ kind: 'length', minLength: 1, maxLength: 2_000 });
  });

  it('accepts both ends of the range', () => {
    expect(parametersOf({ mode: 'simple', description: 'a' }).description).toBe('a');
    expect(parametersOf({ mode: 'simple', description: 'x'.repeat(2_000) }).description).toHaveLength(
      2_000,
    );
  });

  it('treats an omitted description as Requirement 3.6 random generation, not as a violation', () => {
    const parameters = parametersOf({ mode: 'simple' });

    expect(parameters.description).toBeUndefined();
    expect(parameters.sampleMode).toBe(true);
  });
});

describe('Requirement 3.8 — an unsupported language is refused with the supported list', () => {
  it('returns every accepted code so the caller can choose again', () => {
    const violation = violationFor({ mode: 'simple', description: 'a ballad', vocalLanguage: 'kr' }, 'vocalLanguage');

    expect(violation.received).toBe('kr');
    expect(violation.allowed).toEqual({ kind: 'enum', values: ACCEPTED_VOCAL_LANGUAGES });
  });
});

describe('Requirement 3.1 / 3.2 — mode-derived values', () => {
  it('turns sample mode on for Simple_Mode and off for Custom_Mode', () => {
    expect(parametersOf({ mode: 'simple', description: 'a hook' }).sampleMode).toBe(true);
    expect(parametersOf({ mode: 'custom', caption: 'a hook' }).sampleMode).toBe(false);
  });

  it('defaults thinking to true in both modes', () => {
    expect(parametersOf({ mode: 'simple', description: 'a hook' }).thinking).toBe(true);
    expect(parametersOf({ mode: 'custom', caption: 'a hook' }).thinking).toBe(true);
  });
});

describe('Requirement 4.6 — an out-of-range field is named with its allowed range', () => {
  it('rejects a length outside 10 to 600 seconds', () => {
    expect(violationFor({ mode: 'custom', durationSeconds: 9 }, 'durationSeconds').allowed).toEqual({
      kind: 'range',
      min: 10,
      max: 600,
      integer: false,
    });
    expect(violationFor({ mode: 'custom', durationSeconds: 601 }, 'durationSeconds')).toBeDefined();
  });

  it('rejects a BPM outside 30 to 300, and a non-integer one', () => {
    expect(violationFor({ mode: 'custom', bpm: 29 }, 'bpm').allowed).toEqual({
      kind: 'range',
      min: 30,
      max: 300,
      integer: true,
    });
    expect(violationFor({ mode: 'custom', bpm: 301 }, 'bpm')).toBeDefined();
    expect(violationFor({ mode: 'custom', bpm: 120.5 }, 'bpm')).toBeDefined();
  });

  it('rejects a time signature outside 2, 3, 4, 6', () => {
    expect(violationFor({ mode: 'custom', timeSignature: 5 }, 'timeSignature').allowed).toEqual({
      kind: 'enum',
      values: [2, 3, 4, 6],
    });
  });

  it('rejects a key outside the 70 combinations and returns all of them', () => {
    const violation = violationFor({ mode: 'custom', keyScale: 'H major' }, 'keyScale');

    expect(violation.allowed).toEqual({ kind: 'enum', values: VALID_KEY_SCALES });
  });

  it('reports every violated field at once rather than the first', () => {
    const fields = violationsOf({
      mode: 'custom',
      bpm: 1_000,
      keyScale: 'nonsense',
      timeSignature: 7,
      durationSeconds: 5,
    })
      .map((violation) => violation.field)
      .sort();

    expect(fields).toEqual(['bpm', 'durationSeconds', 'keyScale', 'timeSignature']);
  });

  it('accepts every boundary value', () => {
    const parameters = parametersOf({
      mode: 'custom',
      bpm: 30,
      timeSignature: 2,
      durationSeconds: 10,
      keyScale: 'A major',
    });

    expect(parameters.bpm).toBe(30);
    expect(parametersOf({ mode: 'custom', bpm: 300, durationSeconds: 600 }).bpm).toBe(300);
  });
});

describe('Requirement 4.7 — a partially specified request keeps what the user gave', () => {
  it('leaves unspecified metadata absent and preserves the specified values', () => {
    const parameters = parametersOf({ mode: 'custom', caption: 'lo-fi', bpm: 82 });

    expect(parameters.bpm).toBe(82);
    expect(parameters.keyScale).toBeUndefined();
    expect(parameters.timeSignature).toBeUndefined();
    expect(parameters.durationSeconds).toBeUndefined();
  });
});

describe('Requirement 4.8 — the batch count is 1 to 8', () => {
  it('rejects 0 and 9 with the allowed range', () => {
    expect(violationFor({ mode: 'custom', batchSize: 0 }, 'batchSize').allowed).toEqual({
      kind: 'range',
      min: 1,
      max: 8,
      integer: true,
    });
    expect(violationFor({ mode: 'custom', batchSize: 9 }, 'batchSize')).toBeDefined();
  });

  it('resolves an unspecified count to 1', () => {
    expect(parametersOf({ mode: 'custom', caption: 'lo-fi' }).batchSize).toBe(1);
  });
});

describe('Requirement 4.9 — the instrumental choice becomes the lyrics indicator', () => {
  it('replaces the lyrics with the indicator', () => {
    expect(parametersOf({ mode: 'custom', instrumental: true, lyrics: 'ignored' }).lyrics).toBe(
      INSTRUMENTAL_LYRICS,
    );
  });

  it('keeps the lyrics when the track is not instrumental', () => {
    expect(parametersOf({ mode: 'custom', lyrics: '[verse]\nsung' }).lyrics).toBe('[verse]\nsung');
  });
});

describe('Requirement 4.10 — the seed must survive a round trip', () => {
  it('rejects a negative or fractional seed', () => {
    expect(violationFor({ mode: 'custom', seed: -1 }, 'seed')).toBeDefined();
    expect(violationFor({ mode: 'custom', seed: 1.5 }, 'seed')).toBeDefined();
  });

  it('accepts 0 as a seed, which is a legitimate value', () => {
    expect(parametersOf({ mode: 'custom', seed: 0 }).seed).toBe(0);
  });
});
