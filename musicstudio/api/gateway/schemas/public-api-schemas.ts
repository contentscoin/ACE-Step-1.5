import { API_KEY_LABEL_MAX_LENGTH } from '../../../domain/public-api/api-key';
import { WEBHOOK_URL_MAX_LENGTH } from '../../../domain/public-api/webhook';

/**
 * Schemas for API key management and the developer surface (Requirement 17).
 *
 * Bounds are restated at the transport edge and the service validates independently, as
 * everywhere else in this gateway: a value that slips past a relaxed schema is still rejected.
 *
 * The one schema worth reading closely is `issueApiKeySchema`'s 201 body. It is the only
 * response in the product that contains an API key, and it says so — a generated client should
 * store the value from this call rather than expect to read it back.
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

const apiKeySummary = {
  type: 'object',
  required: ['keyId', 'fingerprint', 'label', 'createdAtMs', 'revokedAtMs'],
  properties: {
    keyId: { type: 'string' },
    /** `ms_live_` plus six characters. Names the key; cannot be used as one. */
    fingerprint: { type: 'string' },
    label: { type: 'string' },
    createdAtMs: { type: 'integer' },
    revokedAtMs: { type: ['integer', 'null'] },
  },
  additionalProperties: false,
} as const;

/** Requirements 17.1, 17.2. */
export const issueApiKeySchema = {
  body: {
    type: 'object',
    required: ['label'],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: API_KEY_LABEL_MAX_LENGTH },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      required: ['summary', 'key'],
      properties: {
        summary: apiKeySummary,
        /**
         * Requirement 17.1 — shown here and nowhere else, ever. The server keeps only a hash
         * (17.2), so a client that does not store this value cannot recover it.
         */
        key: { type: 'string' },
      },
      additionalProperties: false,
    },
    400: errorResponse,
    401: errorResponse,
  },
} as const;

/** Requirement 17.9's list. `apiKeySummary` has `additionalProperties: false`, so a key
 * accidentally added to the payload would be stripped by the serialiser rather than sent. */
export const listApiKeysSchema = {
  response: {
    200: {
      type: 'object',
      required: ['keys'],
      properties: { keys: { type: 'array', items: apiKeySummary } },
      additionalProperties: false,
    },
    401: errorResponse,
  },
} as const;

export const revokeApiKeySchema = {
  params: {
    type: 'object',
    required: ['keyId'],
    properties: { keyId: { type: 'string', minLength: 1 } },
  },
  response: { 200: apiKeySummary, 401: errorResponse, 404: errorResponse },
} as const;

/** Requirements 17.10, 17.14. */
export const setWebhookSchema = {
  params: {
    type: 'object',
    required: ['keyId'],
    properties: { keyId: { type: 'string', minLength: 1 } },
  },
  body: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', minLength: 1, maxLength: WEBHOOK_URL_MAX_LENGTH } },
    additionalProperties: false,
  },
  response: { 204: { type: 'null' }, 400: errorResponse, 401: errorResponse, 404: errorResponse },
} as const;

export const clearWebhookSchema = {
  params: {
    type: 'object',
    required: ['keyId'],
    properties: { keyId: { type: 'string', minLength: 1 } },
  },
  response: { 204: { type: 'null' }, 401: errorResponse, 404: errorResponse },
} as const;

/* ------------------------------------------------- the developer surface */

/** Requirements 17.5, 17.11 — accepted, and the identifier comes straight back. */
export const publicSubmitSchema = {
  body: { type: 'object', additionalProperties: true },
  response: {
    202: {
      type: 'object',
      required: ['jobId', 'state'],
      properties: {
        jobId: { type: 'string' },
        state: { type: 'string' },
        assetKind: { type: 'string' },
      },
      additionalProperties: true,
    },
    400: errorResponse,
    401: errorResponse,
    429: errorResponse,
  },
} as const;

/** Requirement 17.6. */
export const publicJobStatusSchema = {
  params: {
    type: 'object',
    required: ['jobId'],
    properties: { jobId: { type: 'string', minLength: 1 } },
  },
  response: {
    200: { type: 'object', additionalProperties: true },
    401: errorResponse,
    404: errorResponse,
    429: errorResponse,
  },
} as const;

/** Requirement 17.6's credit balance. */
export const publicCreditsSchema = {
  response: {
    200: { type: 'object', additionalProperties: true },
    401: errorResponse,
    429: errorResponse,
  },
} as const;

/** Requirement 17.13 — engines with their License_Descriptor. */
export const publicEnginesSchema = {
  response: {
    200: {
      type: 'object',
      required: ['engines'],
      properties: { engines: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      additionalProperties: false,
    },
    401: errorResponse,
    429: errorResponse,
  },
} as const;
