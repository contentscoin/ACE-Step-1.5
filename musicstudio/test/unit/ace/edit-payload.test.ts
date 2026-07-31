import { describe, expect, it } from 'vitest';

import { ACE_DEFAULT_EDIT_MODEL_CATALOGUE } from '../../../adapters/ace/model-tasks';
import {
  ACE_RANDOM_SEED_SENTINEL,
  buildAceSubmitPayload,
} from '../../../adapters/ace/submit-payload';
import type { EditRequest } from '../../../domain/edit/request';
import type { SourceAudioDescriptor } from '../../../domain/edit/source-audio';
import { validateEditRequest } from '../../../domain/edit/validation';

/**
 * The `/release_task` wire payload for each Edit_Task (Requirements 7.1–7.3, 7.6–7.8).
 *
 * Each of those criteria is a claim about a field on the wire, so each is asserted
 * against the payload itself. Requests go through the real validator first, so what is
 * asserted is what an accepted edit actually produces — including Requirement 7.5's
 * already-clamped end.
 */

const SOURCE: SourceAudioDescriptor = {
  assetId: 'asset-source',
  format: 'mp3',
  durationSeconds: 240,
  sizeBytes: 6 * 1024 * 1024,
  enginePath: '/tmp/ace-uploads/asset-source.mp3',
};

const BASE_MODEL = 'acestep-v15-base';

function payloadFor(request: EditRequest): Readonly<Record<string, unknown>> {
  const validation = validateEditRequest({
    request,
    sourceAudio: SOURCE,
    catalogue: ACE_DEFAULT_EDIT_MODEL_CATALOGUE,
  });
  if (validation.kind === 'invalid') {
    throw new Error(`expected a valid edit, got ${JSON.stringify(validation)}`);
  }
  return buildAceSubmitPayload({
    song: validation.parameters.style,
    edit: validation.parameters,
  });
}

describe('Requirement 7.1 — a cover sends task_type=cover with the source audio', () => {
  it('produces exactly the fields the criterion and its style call for', () => {
    const payload = payloadFor({
      kind: 'cover',
      sourceAssetId: 'asset-source',
      style: { caption: 'acoustic reharmonisation, brushed drums' },
    });

    expect(payload).toEqual({
      task_type: 'cover',
      sample_mode: false,
      thinking: true,
      prompt: 'acoustic reharmonisation, brushed drums',
      batch_size: 1,
      use_random_seed: true,
      seed: ACE_RANDOM_SEED_SENTINEL,
      src_audio_path: SOURCE.enginePath,
      model: 'acestep-v15-turbo',
    });
  });

  it('sends the source on `src_audio_path`, not `reference_audio_path`', () => {
    // The two are different engine inputs: `src_audio` is the audio being operated on
    // and is what cover/repaint/extract/lego require, while `reference_audio` is a
    // separate style reference no criterion mentions.
    const keys = Object.keys(payloadFor({ kind: 'cover', sourceAssetId: 'asset-source' }));

    expect(keys).toContain('src_audio_path');
    expect(keys).not.toContain('reference_audio_path');
  });
});

describe('Requirement 7.2 — the cover strength travels as audio_cover_strength', () => {
  it('sends the validated value', () => {
    const payload = payloadFor({
      kind: 'cover',
      sourceAssetId: 'asset-source',
      coverStrength: 0.35,
    });

    expect(payload.audio_cover_strength).toBe(0.35);
  });

  it('accepts 0.0 as a value rather than treating it as absent', () => {
    expect(
      payloadFor({ kind: 'cover', sourceAssetId: 'asset-source', coverStrength: 0 })
        .audio_cover_strength,
    ).toBe(0);
  });

  it('omits the field when no strength was given, leaving the engine default', () => {
    expect(
      Object.keys(payloadFor({ kind: 'cover', sourceAssetId: 'asset-source' })),
    ).not.toContain('audio_cover_strength');
  });
});

describe('Requirement 7.3 — a repaint sends the interval as repainting_start/end', () => {
  it('sends both bounds with task_type=repaint', () => {
    const payload = payloadFor({
      kind: 'repaint',
      sourceAssetId: 'asset-source',
      repaintStartSeconds: 32.5,
      repaintEndSeconds: 61,
    });

    expect(payload.task_type).toBe('repaint');
    expect(payload.repainting_start).toBe(32.5);
    expect(payload.repainting_end).toBe(61);
  });

  it('sends the clamped end for a Requirement 7.5 overrun, not the requested one', () => {
    const payload = payloadFor({
      kind: 'repaint',
      sourceAssetId: 'asset-source',
      repaintStartSeconds: 100,
      repaintEndSeconds: 10_000,
    });

    expect(payload.repainting_end).toBe(SOURCE.durationSeconds);
  });

  it('never sends a start without an end, which would repaint from zero silently', () => {
    // The engine's `repainting_start` defaults to 0.0, so a lone bound is a trap. The
    // builder writes the pair or neither; the only way to reach it with one is a
    // hand-built parameter set.
    const payload = buildAceSubmitPayload({
      song: { mode: 'custom', sampleMode: false, thinking: true, instrumental: false, batchSize: 1 },
      edit: {
        kind: 'repaint',
        source: { ...SOURCE, format: 'mp3' },
        model: BASE_MODEL,
        style: {
          mode: 'custom',
          sampleMode: false,
          thinking: true,
          instrumental: false,
          batchSize: 1,
        },
        repaintStartSeconds: 5,
      },
    });

    const keys = Object.keys(payload);
    expect(keys).not.toContain('repainting_start');
    expect(keys).not.toContain('repainting_end');
  });
});

describe('Requirement 7.6 — an extract sends task_type=extract with the track name', () => {
  it('sends the chosen track', () => {
    const payload = payloadFor({
      kind: 'extract',
      sourceAssetId: 'asset-source',
      model: BASE_MODEL,
      trackName: 'vocals',
    });

    expect(payload.task_type).toBe('extract');
    expect(payload.track_name).toBe('vocals');
    expect(payload.src_audio_path).toBe(SOURCE.enginePath);
    expect(payload.model).toBe(BASE_MODEL);
  });
});

describe('Requirement 7.7 — a lego sends task_type=lego with the track to add', () => {
  it('sends the chosen track', () => {
    const payload = payloadFor({
      kind: 'lego',
      sourceAssetId: 'asset-source',
      model: BASE_MODEL,
      trackName: 'strings',
    });

    expect(payload.task_type).toBe('lego');
    expect(payload.track_name).toBe('strings');
  });
});

describe('Requirement 7.8 — a complete sends task_type=complete with the audio', () => {
  it('sends the audio and no track fields when none were given', () => {
    const payload = payloadFor({
      kind: 'complete',
      sourceAssetId: 'asset-source',
      model: BASE_MODEL,
    });

    expect(payload.task_type).toBe('complete');
    expect(payload.src_audio_path).toBe(SOURCE.enginePath);
    const keys = Object.keys(payload);
    expect(keys).not.toContain('track_name');
    expect(keys).not.toContain('track_classes');
  });

  it('forwards an optional track class list as track_classes', () => {
    const payload = payloadFor({
      kind: 'complete',
      sourceAssetId: 'asset-source',
      model: BASE_MODEL,
      trackClasses: ['drums', 'bass'],
    });

    expect(payload.track_classes).toEqual(['drums', 'bass']);
  });
});

describe('the edit payload carries nothing the requirements did not ask for', () => {
  it('adds no edit fields to a plain generation', () => {
    const payload = buildAceSubmitPayload({
      song: { mode: 'simple', sampleMode: true, thinking: true, instrumental: false, batchSize: 1 },
    });

    expect(payload.task_type).toBe('text2music');
    for (const field of [
      'src_audio_path',
      'model',
      'audio_cover_strength',
      'repainting_start',
      'repainting_end',
      'track_name',
      'track_classes',
    ]) {
      expect(Object.keys(payload)).not.toContain(field);
    }
  });

  it('is byte-identical for the same edit, so the engine can reproduce it', () => {
    const request: EditRequest = {
      kind: 'cover',
      sourceAssetId: 'asset-source',
      coverStrength: 0.5,
      style: { caption: 'drum and bass', lyrics: '[verse]\nrolling', bpm: 174, seed: 11 },
    };

    expect(JSON.stringify(payloadFor(request))).toBe(JSON.stringify(payloadFor(request)));
  });

  it('keeps the unnamed cover-nofsq variant reachable only by explicit override', () => {
    const validation = validateEditRequest({
      request: { kind: 'cover', sourceAssetId: 'asset-source' },
      sourceAudio: SOURCE,
      catalogue: ACE_DEFAULT_EDIT_MODEL_CATALOGUE,
    });
    if (validation.kind !== 'valid') throw new Error('expected a valid edit');

    expect(
      buildAceSubmitPayload({
        song: validation.parameters.style,
        edit: validation.parameters,
        taskType: 'cover-nofsq',
      }).task_type,
    ).toBe('cover-nofsq');
  });
});
