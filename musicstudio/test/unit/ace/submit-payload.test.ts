import { describe, expect, it } from 'vitest';

import {
  ACE_RANDOM_SEED_SENTINEL,
  buildAceSubmitPayload,
} from '../../../adapters/ace/submit-payload';
import { INSTRUMENTAL_LYRICS } from '../../../domain/song/request';
import { validateSongRequest } from '../../../domain/song/validation';
import type { SongGenerationRequest, SongParameters } from '../../../domain/song/request';

/**
 * The `/release_task` wire payload (Requirements 3.1–3.3, 3.6, 3.7, 4.1–4.5,
 * 4.7–4.10).
 *
 * Each of those criteria is a claim about a field on the wire, so each is asserted
 * against the payload itself rather than against an effect further downstream.
 * Requests go through the real validator first, so what is asserted is what an
 * accepted request actually produces.
 */

function payloadFor(request: SongGenerationRequest): Readonly<Record<string, unknown>> {
  const validation = validateSongRequest(request);
  if (validation.kind === 'invalid') {
    throw new Error(`expected a valid request, got ${JSON.stringify(validation.violations)}`);
  }
  return buildAceSubmitPayload({ song: validation.parameters });
}

describe('Requirement 3.1 — Simple_Mode sends sample_mode with the description', () => {
  it('passes the natural language description as sample_query', () => {
    const payload = payloadFor({ mode: 'simple', description: 'a calm rainy-day piano ballad' });

    expect(payload.sample_mode).toBe(true);
    expect(payload.sample_query).toBe('a calm rainy-day piano ballad');
  });

  it('sends text2music as the task type', () => {
    expect(payloadFor({ mode: 'simple', description: 'lo-fi beat' }).task_type).toBe('text2music');
  });
});

describe('Requirement 3.2 — thinking defaults to true', () => {
  it('is true when the caller says nothing', () => {
    expect(payloadFor({ mode: 'simple', description: 'a jazz waltz' }).thinking).toBe(true);
  });

  it('is only false when the caller explicitly disables it', () => {
    expect(
      payloadFor({ mode: 'simple', description: 'a jazz waltz', thinking: false }).thinking,
    ).toBe(false);
  });
});

describe('Requirement 3.3 — an unspecified length is left empty', () => {
  it('omits audio_duration entirely rather than sending a default', () => {
    const payload = payloadFor({ mode: 'simple', description: 'a short intro sting' });

    expect(Object.keys(payload)).not.toContain('audio_duration');
  });

  it('sends the length when the caller did choose one', () => {
    const payload = payloadFor({ mode: 'simple', description: 'a march', durationSeconds: 90 });

    expect(payload.audio_duration).toBe(90);
  });
});

describe('Requirement 3.6 — random generation carries no description', () => {
  it('keeps sample_mode on and sends no sample_query', () => {
    const payload = payloadFor({ mode: 'simple' });

    expect(payload.sample_mode).toBe(true);
    expect(Object.keys(payload)).not.toContain('sample_query');
    // With no description and no metadata, every musical choice is the engine's.
    expect(Object.keys(payload)).not.toContain('prompt');
    expect(Object.keys(payload)).not.toContain('lyrics');
  });
});

describe('Requirement 3.7 — the vocal language travels as vocal_language', () => {
  it('sends the requested code', () => {
    const payload = payloadFor({ mode: 'simple', description: 'a k-pop hook', vocalLanguage: 'ko' });

    expect(payload.vocal_language).toBe('ko');
  });

  it('omits the field when no language was requested', () => {
    expect(Object.keys(payloadFor({ mode: 'simple', description: 'a hook' }))).not.toContain(
      'vocal_language',
    );
  });
});

describe('Requirement 4.1 — the full lyric text is passed untruncated', () => {
  it('sends the caption as prompt and the lyrics verbatim', () => {
    const lyrics = ['[verse]', 'line one', 'line two', '', '[chorus]', 'a'.repeat(4_000)].join('\n');
    const payload = payloadFor({ mode: 'custom', caption: 'indie rock, gritty', lyrics });

    expect(payload.prompt).toBe('indie rock, gritty');
    expect(payload.lyrics).toBe(lyrics);
    expect(String(payload.lyrics)).toHaveLength(lyrics.length);
  });

  it('turns sample mode off for Custom_Mode', () => {
    expect(payloadFor({ mode: 'custom', caption: 'ambient' }).sample_mode).toBe(false);
  });
});

describe('Requirements 4.2–4.5 — accepted metadata reaches the engine', () => {
  it('sends length, BPM, key and time signature in the engine field names', () => {
    const payload = payloadFor({
      mode: 'custom',
      caption: 'synthwave',
      bpm: 128,
      keyScale: 'F# minor',
      timeSignature: 4,
      durationSeconds: 210.5,
    });

    expect(payload.bpm).toBe(128);
    expect(payload.key_scale).toBe('F# minor');
    // The engine's `time_signature` is a string holding only the numerator.
    expect(payload.time_signature).toBe('4');
    expect(payload.audio_duration).toBe(210.5);
  });
});

describe('Requirement 4.7 — only empty fields are left to the engine', () => {
  it('omits the unspecified fields and keeps the supplied ones exactly', () => {
    const payload = payloadFor({
      mode: 'custom',
      caption: 'bossa nova',
      bpm: 96,
      // key, time signature and length deliberately unspecified.
    });

    expect(payload.bpm).toBe(96);
    const keys = Object.keys(payload);
    expect(keys).not.toContain('key_scale');
    expect(keys).not.toContain('time_signature');
    expect(keys).not.toContain('audio_duration');
  });
});

describe('Requirement 4.8 — the batch count travels as batch_size', () => {
  it('sends the requested count', () => {
    expect(payloadFor({ mode: 'custom', caption: 'techno', batchSize: 8 }).batch_size).toBe(8);
  });

  it('sends 1 when the caller asked for no particular count', () => {
    expect(payloadFor({ mode: 'custom', caption: 'techno' }).batch_size).toBe(1);
  });
});

describe('Requirement 4.9 — an instrumental request marks the lyrics field', () => {
  it('sends the instrumental indicator as the lyrics value', () => {
    const payload = payloadFor({ mode: 'custom', caption: 'post-rock', instrumental: true });

    expect(payload.lyrics).toBe(INSTRUMENTAL_LYRICS);
  });

  it('discards any lyrics supplied alongside the instrumental choice', () => {
    const payload = payloadFor({
      mode: 'custom',
      caption: 'post-rock',
      instrumental: true,
      lyrics: '[verse]\nwords the user then chose not to use',
    });

    expect(payload.lyrics).toBe(INSTRUMENTAL_LYRICS);
  });
});

describe('Requirement 4.10 — an explicit seed disables random seeding', () => {
  it('sends use_random_seed=false with the seed', () => {
    const payload = payloadFor({ mode: 'custom', caption: 'drum and bass', seed: 4_242 });

    expect(payload.use_random_seed).toBe(false);
    expect(payload.seed).toBe(4_242);
  });

  it('produces a byte-identical payload for the same input, so the engine can reproduce it', () => {
    const request: SongGenerationRequest = {
      mode: 'custom',
      caption: 'drum and bass',
      lyrics: '[verse]\nrolling',
      bpm: 174,
      keyScale: 'A minor',
      timeSignature: 4,
      durationSeconds: 120,
      seed: 99,
    };

    expect(JSON.stringify(payloadFor(request))).toBe(JSON.stringify(payloadFor(request)));
  });

  it('keeps random seeding on with the engine sentinel when no seed was given', () => {
    const payload = payloadFor({ mode: 'custom', caption: 'drum and bass' });

    expect(payload.use_random_seed).toBe(true);
    expect(payload.seed).toBe(ACE_RANDOM_SEED_SENTINEL);
  });
});

describe('the payload carries nothing the requirements did not ask for', () => {
  it('sends exactly the fields Simple_Mode needs', () => {
    const payload = payloadFor({ mode: 'simple', description: 'a waltz' });

    expect(Object.keys(payload).sort()).toEqual(
      ['batch_size', 'sample_mode', 'sample_query', 'seed', 'task_type', 'thinking', 'use_random_seed'],
    );
  });

  it('leaves the task type open for the edit tasks without inventing their parameters', () => {
    const song: SongParameters = {
      mode: 'custom',
      sampleMode: false,
      thinking: true,
      instrumental: false,
      batchSize: 1,
      caption: 'a cover',
    };

    expect(buildAceSubmitPayload({ song, taskType: 'cover' }).task_type).toBe('cover');
  });
});
