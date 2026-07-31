import { GENERATION_JOB_STATES } from '../../../domain/generation-job/lifecycle';
import { TRACK_NAMES } from '../../../domain/edit/track-name';

/**
 * Edit_Task request schemas (Requirement 7).
 *
 * Shape only, for the same reason the song schemas check shape only: Requirements
 * 7.4, 7.9 and 7.11 do not merely require a rejection, they require the response to
 * name the violated constraint and state its allowed value, and a Fastify schema
 * rejection cannot say that. So the 0.0–1.0 strength, the interval ordering, the
 * source-audio format/length/size ceilings and the model capability check all live in
 * `domain/edit/` and `services/generation/edit-gateway.ts`.
 *
 * The one exception is `trackName`, which *is* enumerated here. It is not a bound the
 * requirements attach a message to — it is the closed set of twelve values
 * Requirements 7.6 and 7.7 say the field holds — and the domain validator checks it
 * again for callers that do not arrive over HTTP, so nothing is only enforced here.
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

/** Requirement 7.5: the acceptance body carries the adjustments that were applied. */
const acceptanceSchema = {
  type: 'object',
  required: ['jobId', 'engineId', 'queuePosition', 'state', 'adjustments'],
  properties: {
    jobId: { type: 'string' },
    engineId: { type: 'string' },
    queuePosition: { type: 'integer' },
    engineJobId: { type: ['string', 'null'] },
    state: { type: 'string', enum: [...GENERATION_JOB_STATES] },
    estimatedCompletionAtMs: { type: ['integer', 'null'] },
    substitutedEngine: { type: 'boolean' },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'requested', 'applied', 'reason'],
        properties: {
          field: { type: 'string' },
          requested: { type: 'number' },
          applied: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

const responses = {
  202: acceptanceSchema,
  /** Requirements 7.2, 7.4, 7.6, 7.7, 7.10, 7.11 — `edit_request_invalid`. */
  400: errorResponse,
  402: errorResponse,
  403: errorResponse,
  404: errorResponse,
  /** Requirement 7.9 — `edit_task_unsupported`, carrying the supporting models. */
  409: errorResponse,
  422: errorResponse,
  429: errorResponse,
  503: errorResponse,
} as const;

/** Requirement 7.1's new style: the Custom_Mode musical fields, all optional (4.7). */
const style = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    lyrics: { type: 'string' },
    instrumental: { type: 'boolean' },
    bpm: { type: 'integer' },
    keyScale: { type: 'string' },
    timeSignature: { type: 'integer' },
    durationSeconds: { type: 'number' },
    vocalLanguage: { type: 'string' },
    batchSize: { type: 'integer' },
    seed: { type: 'integer' },
    thinking: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

const shared = {
  /** Requirement 7.12's lineage parent, and the audio the edit operates on. */
  sourceAssetId: { type: 'string', minLength: 1 },
  /** Requirement 7.9: the DiT model to run on. */
  model: { type: 'string', minLength: 1, maxLength: 128 },
  engineId: { type: 'string', minLength: 1, maxLength: 64 },
  /** Requirement 16.4: the uploader's rights confirmation. */
  rightsConsent: {
    type: 'object',
    required: ['holdsRights', 'acknowledgedAtMs'],
    properties: {
      holdsRights: { type: 'boolean' },
      acknowledgedAtMs: { type: 'integer' },
    },
    additionalProperties: false,
  },
  style,
} as const;

const trackName = { type: 'string', enum: [...TRACK_NAMES] } as const;

/** Requirements 7.1, 7.2. */
export const createCoverEditSchema = {
  body: {
    type: 'object',
    required: ['sourceAssetId'],
    properties: {
      ...shared,
      /** Requirement 7.2: bounds are checked in the domain, which names them. */
      coverStrength: { type: 'number' },
    },
    additionalProperties: false,
  },
  response: responses,
} as const;

/** Requirements 7.3–7.5. Both bounds are required: there is no default interval. */
export const createRepaintEditSchema = {
  body: {
    type: 'object',
    required: ['sourceAssetId', 'repaintStartSeconds', 'repaintEndSeconds'],
    properties: {
      ...shared,
      repaintStartSeconds: { type: 'number' },
      repaintEndSeconds: { type: 'number' },
    },
    additionalProperties: false,
  },
  response: responses,
} as const;

/** Requirement 7.6. */
export const createExtractEditSchema = {
  body: {
    type: 'object',
    required: ['sourceAssetId', 'trackName'],
    properties: { ...shared, trackName },
    additionalProperties: false,
  },
  response: responses,
} as const;

/** Requirement 7.7. */
export const createLegoEditSchema = {
  body: {
    type: 'object',
    required: ['sourceAssetId', 'trackName'],
    properties: { ...shared, trackName },
    additionalProperties: false,
  },
  response: responses,
} as const;

/** Requirement 7.8. */
export const createCompleteEditSchema = {
  body: {
    type: 'object',
    required: ['sourceAssetId'],
    properties: {
      ...shared,
      trackClasses: { type: 'array', items: trackName, minItems: 1, maxItems: TRACK_NAMES.length },
    },
    additionalProperties: false,
  },
  response: responses,
} as const;
