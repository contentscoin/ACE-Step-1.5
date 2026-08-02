/**
 * Lyric enrichment, draft and LRC download schemas (Requirements 8, 10.8).
 *
 * Shape only, for the same reason `song-schemas.ts` gives: musical bounds live in
 * `domain/song/validation.ts`, and restating them here would both duplicate them and
 * replace the field-plus-allowance rejection those requirements ask for with
 * Fastify's generic `validation_failed`.
 *
 * One bound *is* enforced here, because it is about the transport rather than about
 * music: `caption`, `lyrics` and `topic` have maximum lengths, so an unbounded body
 * cannot be used to make the gateway hold an arbitrarily large string in memory
 * before any handler runs.
 */

const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
} as const;

/** Requirement 3.5's ceiling reused: the caption is the same field a song request takes. */
const CAPTION_MAX_LENGTH = 2_000;
/** Generous but finite; Requirement 4.1 forbids truncating what the user wrote. */
const LYRICS_MAX_LENGTH = 20_000;

const musicalHints = {
  bpm: { type: 'integer' },
  keyScale: { type: 'string' },
  timeSignature: { type: 'integer' },
  durationSeconds: { type: 'number' },
  vocalLanguage: { type: 'string' },
} as const;

/** One side of Requirement 8.2's comparison. Every musical field may be `null`. */
const candidateSchema = {
  type: 'object',
  required: [
    'caption',
    'lyrics',
    'bpm',
    'keyScale',
    'timeSignature',
    'durationSeconds',
    'vocalLanguage',
  ],
  properties: {
    caption: { type: 'string' },
    lyrics: { type: 'string' },
    bpm: { type: ['integer', 'null'] },
    keyScale: { type: ['string', 'null'] },
    timeSignature: { type: ['integer', 'null'] },
    durationSeconds: { type: ['number', 'null'] },
    vocalLanguage: { type: ['string', 'null'] },
  },
  additionalProperties: false,
} as const;

const sectionSchema = {
  type: 'object',
  required: ['kind', 'label', 'lines'],
  properties: {
    kind: { type: 'string', enum: ['leading', 'recognised', 'custom'] },
    /** `null` for the Requirement 9.3 leading section, which has no tag. */
    label: { type: ['string', 'null'] },
    lines: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

const warningSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    line: { type: 'integer' },
    actual: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/**
 * Requirement 8.1 + 8.2.
 *
 * The body carries both sides and, pointedly, no `selected` field: Requirement 8.2
 * requires the user to choose, so the response cannot contain a choice.
 */
export const createLyricsEnrichmentSchema = {
  body: {
    type: 'object',
    required: ['caption', 'lyrics'],
    properties: {
      caption: { type: 'string', maxLength: CAPTION_MAX_LENGTH },
      lyrics: { type: 'string', maxLength: LYRICS_MAX_LENGTH },
      ...musicalHints,
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['original', 'enriched', 'enrichedStructure', 'choices'],
      properties: {
        original: candidateSchema,
        enriched: candidateSchema,
        enrichedStructure: { type: 'array', items: sectionSchema },
        warnings: { type: 'array', items: warningSchema },
        /** The two values `POST /songs/*` will accept as the user's decision. */
        choices: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    400: errorResponse,
    /** Requirement 8.5: the engine failed and the original is echoed unchanged. */
    502: errorResponse,
  },
} as const;

/** Requirements 8.3, 8.4. */
export const createLyricsDraftSchema = {
  body: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string', minLength: 1, maxLength: CAPTION_MAX_LENGTH },
      ...musicalHints,
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['caption', 'lyrics', 'structure'],
      properties: {
        caption: { type: 'string' },
        lyrics: { type: 'string' },
        structure: { type: 'array', items: sectionSchema },
        bpm: { type: ['integer', 'null'] },
        keyScale: { type: ['string', 'null'] },
        timeSignature: { type: ['integer', 'null'] },
        durationSeconds: { type: ['number', 'null'] },
        vocalLanguage: { type: ['string', 'null'] },
        warnings: { type: 'array', items: warningSchema },
      },
      additionalProperties: false,
    },
    400: errorResponse,
    502: errorResponse,
  },
} as const;

/**
 * Requirement 10.8.
 *
 * No `response` entry for 200: the body is an LRC file, not JSON, and a serialiser
 * schema would try to coerce it into an object.
 */
export const downloadTimedLyricsSchema = {
  params: {
    type: 'object',
    required: ['trackId'],
    properties: { trackId: { type: 'string', minLength: 1, maxLength: 128 } },
    additionalProperties: false,
  },
  querystring: {
    type: 'object',
    required: ['trackDurationMs'],
    properties: {
      /** Requirement 10.7's upper bound, supplied by the caller that owns the track. */
      trackDurationMs: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  response: {
    400: errorResponse,
    404: errorResponse,
    /** Requirement 10.7 violated by the stored timings. */
    409: errorResponse,
  },
} as const;
