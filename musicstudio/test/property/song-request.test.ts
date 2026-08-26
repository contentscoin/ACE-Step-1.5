import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildAceSubmitPayload } from '../../adapters/ace/submit-payload';
import {
  SONG_BATCH_SIZE_MAX,
  SONG_BATCH_SIZE_MIN,
  SONG_BPM_MAX,
  SONG_BPM_MIN,
  SONG_CAPTION_MAX_LENGTH,
  SONG_CAPTION_MIN_LENGTH,
  SONG_DESCRIPTION_MAX_LENGTH,
  SONG_DURATION_SECONDS_MAX,
  SONG_DURATION_SECONDS_MIN,
  SONG_TIME_SIGNATURES,
} from '../../domain/song/engine-bounds';
import { VALID_KEY_SCALES } from '../../domain/song/key-scale';
import type { CustomModeSongRequest, SimpleModeSongRequest } from '../../domain/song/request';
import { validateSongRequest } from '../../domain/song/validation';
import { ACCEPTED_VOCAL_LANGUAGES } from '../../domain/song/vocal-language';

/**
 * Local invariants of song request handling (task 2.1). These are *not* the numbered
 * correctness properties of design §10, which cover parsers, mixdown, loudness and
 * licensing.
 *
 * They pin the two Requirement 3 and 4 rules whose correctness is a claim about
 * *every* request rather than about a handful of examples:
 *
 * - Requirements 3.3 and 4.7: a field the caller left empty must never appear on the
 *   wire. Stated per-example that is four assertions; stated over the whole input
 *   space it is one, and it catches any future field that acquires a default.
 * - Requirement 4.1: the lyric text the engine receives is byte-identical to what
 *   the user wrote. Truncation bugs hide behind short examples, so the generator
 *   produces long multi-line text.
 */

const NUM_RUNS = 100;

/** Only in-bounds values: this generator's job is to explore *accepted* requests. */
const inBoundsOptional = {
  durationSeconds: fc.double({
    min: SONG_DURATION_SECONDS_MIN,
    max: SONG_DURATION_SECONDS_MAX,
    noNaN: true,
  }),
  vocalLanguage: fc.constantFrom(...ACCEPTED_VOCAL_LANGUAGES),
  batchSize: fc.integer({ min: SONG_BATCH_SIZE_MIN, max: SONG_BATCH_SIZE_MAX }),
  seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  thinking: fc.boolean(),
};

const simpleArbitrary: fc.Arbitrary<SimpleModeSongRequest> = fc
  .record(
    {
      description: fc.string({ minLength: 1, maxLength: SONG_DESCRIPTION_MAX_LENGTH }),
      ...inBoundsOptional,
    },
    { requiredKeys: [] },
  )
  .map((fields) => ({ mode: 'simple', ...fields }));

const customArbitrary: fc.Arbitrary<CustomModeSongRequest> = fc
  .record(
    {
      // Drawn from the bound rather than from a round number, so this arbitrary keeps meaning
      // "in bounds" if the engine's caption limit moves. It generated the empty string before
      // there was a lower bound, which is what this property caught when one arrived.
      caption: fc.string({ minLength: SONG_CAPTION_MIN_LENGTH, maxLength: SONG_CAPTION_MAX_LENGTH }),
      lyrics: fc.string({ maxLength: 500 }),
      instrumental: fc.boolean(),
      bpm: fc.integer({ min: SONG_BPM_MIN, max: SONG_BPM_MAX }),
      keyScale: fc.constantFrom(...VALID_KEY_SCALES),
      timeSignature: fc.constantFrom(...SONG_TIME_SIGNATURES),
      ...inBoundsOptional,
    },
    { requiredKeys: [] },
  )
  .map((fields) => ({ mode: 'custom', ...fields }));

/** The engine field each optional request field maps to, when it is supplied. */
const WIRE_FIELD_FOR = {
  description: 'sample_query',
  caption: 'prompt',
  lyrics: 'lyrics',
  bpm: 'bpm',
  keyScale: 'key_scale',
  timeSignature: 'time_signature',
  durationSeconds: 'audio_duration',
  vocalLanguage: 'vocal_language',
} as const;

function payloadFor(
  request: SimpleModeSongRequest | CustomModeSongRequest,
): Readonly<Record<string, unknown>> {
  const validation = validateSongRequest(request);
  if (validation.kind === 'invalid') {
    throw new Error(`in-bounds request was rejected: ${JSON.stringify(validation.violations)}`);
  }
  return buildAceSubmitPayload({ song: validation.parameters });
}

describe('Requirements 3.3, 4.7 — an omitted field never reaches the engine', () => {
  it('holds for every in-bounds Simple_Mode request', () => {
    fc.assert(
      fc.property(simpleArbitrary, (request) => {
        const keys = Object.keys(payloadFor(request));
        for (const [field, wireField] of Object.entries(WIRE_FIELD_FOR)) {
          if (!(field in request)) expect(keys).not.toContain(wireField);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('holds for every in-bounds Custom_Mode request', () => {
    fc.assert(
      fc.property(customArbitrary, (request) => {
        const keys = Object.keys(payloadFor(request));
        for (const [field, wireField] of Object.entries(WIRE_FIELD_FOR)) {
          // Requirement 4.9 is the one exception: choosing an instrumental track
          // *supplies* the lyrics field even when the caller sent no lyrics.
          if (field === 'lyrics' && request.instrumental === true) continue;
          if (!(field in request)) expect(keys).not.toContain(wireField);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Requirement 4.1 — the lyric text is never altered', () => {
  it('sends multi-line lyrics of any length byte for byte', () => {
    const lyricsArbitrary = fc
      .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 60 })
      .map((lines) => lines.join('\n'));

    fc.assert(
      fc.property(lyricsArbitrary, (lyrics) => {
        const payload = payloadFor({ mode: 'custom', caption: 'a song', lyrics });
        // An all-whitespace lyric block carries no lyrics, and the engine reads an
        // empty lyrics field as instrumental; anything else must arrive unchanged.
        if (lyrics === '') {
          expect(payload.lyrics).toBe('');
        } else {
          expect(payload.lyrics).toBe(lyrics);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('validation accepts everything inside the engine bounds', () => {
  it('never rejects an in-bounds request of either mode', () => {
    fc.assert(
      fc.property(fc.oneof(simpleArbitrary, customArbitrary), (request) => {
        expect(validateSongRequest(request).kind).toBe('valid');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
