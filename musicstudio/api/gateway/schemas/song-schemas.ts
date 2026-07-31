import { GENERATION_JOB_STATES } from '../../../domain/generation-job/lifecycle';

/**
 * Simple_Mode and Custom_Mode request schemas (Requirements 3, 4).
 *
 * These schemas check *shape* and nothing else: the right JSON type per field, and
 * no unknown properties. Every musical bound — the 1–2000 character description,
 * 10–600 seconds, 30–300 BPM, the four time signatures, the 70 key/scale
 * combinations, the 50 vocal languages, the 1–8 batch — is deliberately absent
 * here, because Requirements 3.5, 3.8 and 4.6 do not merely require a rejection:
 * they require the response to name the violated field and state what would have
 * been accepted. Fastify's schema rejection cannot say that; it produces a generic
 * `validation_failed`.
 *
 * So bounds live in `domain/song/validation.ts`, which returns the field-plus-
 * allowance payload those criteria specify, and which every caller goes through —
 * HTTP or not. Restating the bounds here would both duplicate them and shadow the
 * very error the requirements ask for.
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

/** Same acceptance body the generic Requirement 5.1 endpoint returns. */
const acceptanceSchema = {
  type: 'object',
  required: ['jobId', 'engineId', 'queuePosition', 'state'],
  properties: {
    jobId: { type: 'string' },
    engineId: { type: 'string' },
    queuePosition: { type: 'integer' },
    engineJobId: { type: ['string', 'null'] },
    state: { type: 'string', enum: [...GENERATION_JOB_STATES] },
    estimatedCompletionAtMs: { type: ['integer', 'null'] },
    substitutedEngine: { type: 'boolean' },
  },
} as const;

const responses = {
  202: acceptanceSchema,
  /** Requirements 3.5, 3.8, 4.6 — `song_request_invalid`, carrying the violations. */
  400: errorResponse,
  402: errorResponse,
  403: errorResponse,
  422: errorResponse,
  429: errorResponse,
  503: errorResponse,
} as const;

const engineId = { type: 'string', minLength: 1, maxLength: 64 } as const;

export const createSimpleSongSchema = {
  body: {
    type: 'object',
    // Nothing is required: Requirement 3.6's random generation is this endpoint
    // called with an empty body.
    properties: {
      /** Requirement 3.1: travels to the engine as `sample_query`. */
      description: { type: 'string' },
      /** Requirement 3.2: absent means `true`. */
      thinking: { type: 'boolean' },
      /** Requirement 3.3: absent leaves the length to the engine. */
      durationSeconds: { type: 'number' },
      /** Requirement 3.7. */
      vocalLanguage: { type: 'string' },
      /** Requirement 4.8. */
      batchSize: { type: 'integer' },
      /** Requirement 4.10. */
      seed: { type: 'integer' },
      engineId,
    },
    additionalProperties: false,
  },
  response: responses,
} as const;

export const createCustomSongSchema = {
  body: {
    type: 'object',
    // Requirement 4.7: any subset may be given, so no field is required.
    properties: {
      caption: { type: 'string' },
      /** Requirement 4.1: passed untruncated, hence no length ceiling. */
      lyrics: { type: 'string' },
      /** Requirement 4.9. */
      instrumental: { type: 'boolean' },
      /** Requirement 4.3. */
      bpm: { type: 'integer' },
      /** Requirement 4.5. */
      keyScale: { type: 'string' },
      /** Requirement 4.4. */
      timeSignature: { type: 'integer' },
      /** Requirement 4.2. */
      durationSeconds: { type: 'number' },
      vocalLanguage: { type: 'string' },
      batchSize: { type: 'integer' },
      seed: { type: 'integer' },
      thinking: { type: 'boolean' },
      engineId,
    },
    additionalProperties: false,
  },
  response: responses,
} as const;
