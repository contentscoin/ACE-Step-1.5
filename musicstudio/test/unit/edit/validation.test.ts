import { describe, expect, it } from 'vitest';

import {
  ACE_DEFAULT_EDIT_MODEL_CATALOGUE,
  ACE_DEFAULT_DIT_MODEL,
} from '../../../adapters/ace/model-tasks';
import { COVER_STRENGTH_MAX, COVER_STRENGTH_MIN } from '../../../domain/edit/cover-strength';
import { modelsSupportingEditKind } from '../../../domain/edit/model-support';
import type { EditRequest } from '../../../domain/edit/request';
import {
  SOURCE_AUDIO_FORMATS,
  SOURCE_AUDIO_MAX_BYTES,
  SOURCE_AUDIO_MAX_DURATION_SECONDS,
  type SourceAudioDescriptor,
} from '../../../domain/edit/source-audio';
import { TRACK_NAMES } from '../../../domain/edit/track-name';
import { validateEditRequest } from '../../../domain/edit/validation';

/**
 * Edit_Task validation (Requirements 7.2, 7.4, 7.5, 7.6, 7.7, 7.9, 7.10, 7.11).
 *
 * Every criterion here is a statement about what is accepted or refused *before*
 * anything is submitted, so each is asserted against the pure validator rather than
 * through the gateway. The gateway's own tests then check that a refusal really does
 * stop the request.
 */

const SOURCE: SourceAudioDescriptor = {
  assetId: 'asset-1',
  format: 'wav',
  durationSeconds: 180,
  sizeBytes: 4 * 1024 * 1024,
  enginePath: '/tmp/ace/asset-1.wav',
};

/** A base checkpoint, which is the only family that supports all five kinds. */
const BASE_MODEL = 'acestep-v15-base';

function validate(request: EditRequest, source: SourceAudioDescriptor = SOURCE) {
  return validateEditRequest({
    request,
    sourceAudio: source,
    catalogue: ACE_DEFAULT_EDIT_MODEL_CATALOGUE,
  });
}

describe('Requirement 7.2 — cover strength is validated to 0.0..1.0', () => {
  it.each([COVER_STRENGTH_MIN, 0.25, 0.5, COVER_STRENGTH_MAX])(
    'accepts %s',
    (coverStrength) => {
      const result = validate({ kind: 'cover', sourceAssetId: 'asset-1', coverStrength });

      expect(result.kind).toBe('valid');
      if (result.kind !== 'valid') return;
      expect(result.parameters.coverStrength).toBe(coverStrength);
    },
  );

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s and states the allowed range',
    (coverStrength) => {
      const result = validate({ kind: 'cover', sourceAssetId: 'asset-1', coverStrength });

      expect(result.kind).toBe('invalid');
      if (result.kind !== 'invalid') return;
      expect(result.violations).toEqual([
        {
          field: 'coverStrength',
          received: coverStrength,
          allowed: { kind: 'range', min: 0, max: 1, integer: false },
        },
      ]);
    },
  );

  it('leaves the field absent when the caller gave no strength', () => {
    const result = validate({ kind: 'cover', sourceAssetId: 'asset-1' });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(Object.keys(result.parameters)).not.toContain('coverStrength');
  });
});

describe('Requirement 7.4 — a repaint start at or after the end is refused', () => {
  it.each([
    { start: 30, end: 20 },
    { start: 20, end: 20 },
  ])('refuses start=$start end=$end with the ordering violation', ({ start, end }) => {
    const result = validate({
      kind: 'repaint',
      sourceAssetId: 'asset-1',
      model: BASE_MODEL,
      repaintStartSeconds: start,
      repaintEndSeconds: end,
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations).toEqual([
      {
        field: 'repaintStartSeconds',
        received: { startSeconds: start, endSeconds: end },
        allowed: {
          kind: 'ordering',
          before: 'repaintStartSeconds',
          after: 'repaintEndSeconds',
        },
      },
    ]);
  });

  it('reports the ordering violation even when the end also overruns the source', () => {
    // Without checking 7.4 on the values as given, clamping the end to 180 would turn
    // `{200, 190}` into `{200, 180}` — still inverted, but reported as a range problem
    // on a value the caller never sent.
    const result = validate({
      kind: 'repaint',
      sourceAssetId: 'asset-1',
      repaintStartSeconds: 200,
      repaintEndSeconds: 190,
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]?.allowed.kind).toBe('ordering');
  });
});

describe('Requirement 7.5 — a repaint end past the source length is clamped, not refused', () => {
  it('accepts the request with the end moved to the source length and reports it', () => {
    const result = validate({
      kind: 'repaint',
      sourceAssetId: 'asset-1',
      repaintStartSeconds: 120,
      repaintEndSeconds: 900,
    });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.repaintStartSeconds).toBe(120);
    expect(result.parameters.repaintEndSeconds).toBe(SOURCE.durationSeconds);
    expect(result.adjustments).toEqual([
      {
        field: 'repaintEndSeconds',
        requested: 900,
        applied: SOURCE.durationSeconds,
        reason: 'clamped_to_source_length',
      },
    ]);
  });

  it('reports no adjustment when the interval already fits', () => {
    const result = validate({
      kind: 'repaint',
      sourceAssetId: 'asset-1',
      repaintStartSeconds: 10,
      repaintEndSeconds: 20,
    });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.adjustments).toEqual([]);
  });

  it('still refuses a start beyond the source length, which no clamp can rescue', () => {
    const result = validate({
      kind: 'repaint',
      sourceAssetId: 'asset-1',
      repaintStartSeconds: 400,
      repaintEndSeconds: 500,
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]?.field).toBe('repaintStartSeconds');
    expect(result.violations[0]?.allowed).toEqual({
      kind: 'range',
      min: 0,
      max: SOURCE.durationSeconds,
      integer: false,
    });
  });
});

describe('Requirements 7.6 / 7.7 — extract and lego name one of the twelve tracks', () => {
  it.each(['extract', 'lego'] as const)('accepts every track name for %s', (kind) => {
    for (const trackName of TRACK_NAMES) {
      const result = validate({ kind, sourceAssetId: 'asset-1', model: BASE_MODEL, trackName });

      expect(result.kind, trackName).toBe('valid');
      if (result.kind !== 'valid') continue;
      expect(result.parameters.trackName).toBe(trackName);
    }
  });

  it.each(['extract', 'lego'] as const)(
    'refuses an unknown track for %s and returns the twelve accepted names',
    (kind) => {
      const result = validate({
        kind,
        sourceAssetId: 'asset-1',
        model: BASE_MODEL,
        // Not a member: the engine's list has `backing_vocals`, not `harmonica`.
        trackName: 'harmonica' as never,
      });

      expect(result.kind).toBe('invalid');
      if (result.kind !== 'invalid') return;
      expect(result.violations).toEqual([
        { field: 'trackName', received: 'harmonica', allowed: { kind: 'enum', values: TRACK_NAMES } },
      ]);
    },
  );
});

describe('Requirement 7.8 — complete carries the audio and optionally a track list', () => {
  it('accepts a request with no track classes at all', () => {
    const result = validate({ kind: 'complete', sourceAssetId: 'asset-1', model: BASE_MODEL });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(Object.keys(result.parameters)).not.toContain('trackClasses');
    expect(result.parameters.source.enginePath).toBe(SOURCE.enginePath);
  });

  it('refuses an unknown track class', () => {
    const result = validate({
      kind: 'complete',
      sourceAssetId: 'asset-1',
      model: BASE_MODEL,
      trackClasses: ['drums', 'kazoo' as never],
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]?.field).toBe('trackClasses');
    expect(result.violations[0]?.received).toEqual(['kazoo']);
  });
});

describe('Requirement 7.9 — an edit the selected model cannot do names the models that can', () => {
  it.each(['extract', 'lego', 'complete'] as const)(
    'refuses %s on the default turbo model and lists the base models',
    (kind) => {
      const request =
        kind === 'complete'
          ? ({ kind, sourceAssetId: 'asset-1' } as EditRequest)
          : ({ kind, sourceAssetId: 'asset-1', trackName: 'drums' } as EditRequest);
      const result = validate(request);

      expect(result.kind).toBe('invalid');
      if (result.kind !== 'invalid') return;
      const [violation] = result.violations;
      expect(violation?.field).toBe('kind');
      expect(violation?.received).toBe(kind);
      expect(violation?.allowed).toEqual({
        kind: 'models',
        supportedBy: modelsSupportingEditKind(ACE_DEFAULT_EDIT_MODEL_CATALOGUE, kind),
      });
      // The list is non-empty and excludes the model that was asked.
      expect(violation?.allowed.kind === 'models' ? violation.allowed.supportedBy : []).toContain(
        BASE_MODEL,
      );
      expect(
        violation?.allowed.kind === 'models' ? violation.allowed.supportedBy : [],
      ).not.toContain(ACE_DEFAULT_DIT_MODEL);
    },
  );

  it.each(['cover', 'repaint'] as const)('accepts %s on the turbo model', (kind) => {
    const request =
      kind === 'cover'
        ? ({ kind, sourceAssetId: 'asset-1' } as EditRequest)
        : ({
            kind,
            sourceAssetId: 'asset-1',
            repaintStartSeconds: 1,
            repaintEndSeconds: 2,
          } as EditRequest);

    expect(validate(request).kind).toBe('valid');
  });

  it('refuses a model the catalogue has never heard of rather than assuming it works', () => {
    const result = validate({
      kind: 'cover',
      sourceAssetId: 'asset-1',
      model: 'someone-elses-checkpoint',
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]?.allowed.kind).toBe('models');
  });

  it('falls back to the engine default model when the request names none', () => {
    const result = validate({ kind: 'cover', sourceAssetId: 'asset-1' });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.model).toBe(ACE_DEFAULT_DIT_MODEL);
  });
});

describe('Requirements 7.10 / 7.11 — the source audio is validated, and refusals name the constraint', () => {
  it.each([...SOURCE_AUDIO_FORMATS])('accepts %s', (format) => {
    expect(validate({ kind: 'cover', sourceAssetId: 'asset-1' }, { ...SOURCE, format }).kind).toBe(
      'valid',
    );
  });

  it('refuses another format and returns the three accepted ones', () => {
    const result = validate({ kind: 'cover', sourceAssetId: 'asset-1' }, { ...SOURCE, format: 'ogg' });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations).toEqual([
      {
        field: 'sourceAudio.format',
        received: 'ogg',
        allowed: { kind: 'enum', values: SOURCE_AUDIO_FORMATS },
      },
    ]);
  });

  it('accepts audio at exactly 600 seconds and refuses one second more', () => {
    const atLimit = { ...SOURCE, durationSeconds: SOURCE_AUDIO_MAX_DURATION_SECONDS };
    const overLimit = { ...SOURCE, durationSeconds: SOURCE_AUDIO_MAX_DURATION_SECONDS + 1 };

    expect(validate({ kind: 'cover', sourceAssetId: 'asset-1' }, atLimit).kind).toBe('valid');

    const result = validate({ kind: 'cover', sourceAssetId: 'asset-1' }, overLimit);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]).toEqual({
      field: 'sourceAudio.durationSeconds',
      received: SOURCE_AUDIO_MAX_DURATION_SECONDS + 1,
      allowed: { kind: 'range', min: 0, max: SOURCE_AUDIO_MAX_DURATION_SECONDS, integer: false },
    });
  });

  it('accepts audio at exactly 50 MB and refuses one byte more', () => {
    expect(
      validate({ kind: 'cover', sourceAssetId: 'asset-1' }, { ...SOURCE, sizeBytes: SOURCE_AUDIO_MAX_BYTES })
        .kind,
    ).toBe('valid');

    const result = validate(
      { kind: 'cover', sourceAssetId: 'asset-1' },
      { ...SOURCE, sizeBytes: SOURCE_AUDIO_MAX_BYTES + 1 },
    );
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]).toEqual({
      field: 'sourceAudio.sizeBytes',
      received: SOURCE_AUDIO_MAX_BYTES + 1,
      allowed: { kind: 'bytes', maxBytes: SOURCE_AUDIO_MAX_BYTES },
    });
  });

  it('reports every violated upload constraint at once', () => {
    const result = validate(
      { kind: 'cover', sourceAssetId: 'asset-1' },
      { ...SOURCE, format: 'aac', durationSeconds: 1_200, sizeBytes: SOURCE_AUDIO_MAX_BYTES * 2 },
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations.map((violation) => violation.field)).toEqual([
      'sourceAudio.format',
      'sourceAudio.durationSeconds',
      'sourceAudio.sizeBytes',
    ]);
  });

  it('refuses a bad upload before clamping a repaint interval against its length', () => {
    // A source that failed 7.10 has no trustworthy length, so 7.5 must not report an
    // adjustment derived from it.
    const result = validate(
      {
        kind: 'repaint',
        sourceAssetId: 'asset-1',
        repaintStartSeconds: 1,
        repaintEndSeconds: 10_000,
      },
      { ...SOURCE, format: 'aiff' },
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations.map((violation) => violation.field)).toEqual(['sourceAudio.format']);
  });
});

describe('Requirement 7.1 — the new style is validated by Requirement 4 rules', () => {
  it('carries an accepted style through onto the parameters', () => {
    const result = validate({
      kind: 'cover',
      sourceAssetId: 'asset-1',
      style: { caption: 'bossa nova reharmonisation', bpm: 96, keyScale: 'F major' },
    });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters.style.caption).toBe('bossa nova reharmonisation');
    expect(result.parameters.style.bpm).toBe(96);
    expect(result.parameters.style.sampleMode).toBe(false);
  });

  it('reports a style violation in Requirement 4.6 form rather than flattening it', () => {
    const result = validate({
      kind: 'cover',
      sourceAssetId: 'asset-1',
      style: { caption: 'a cover', bpm: 999 },
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations).toEqual([]);
    expect(result.styleViolations).toEqual([
      { field: 'bpm', received: 999, allowed: { kind: 'range', min: 30, max: 300, integer: true } },
    ]);
  });

  it('treats an absent style as leaving every musical choice to the engine', () => {
    const result = validate({ kind: 'cover', sourceAssetId: 'asset-1' });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(Object.keys(result.parameters.style)).not.toContain('caption');
    expect(Object.keys(result.parameters.style)).not.toContain('bpm');
  });
});
