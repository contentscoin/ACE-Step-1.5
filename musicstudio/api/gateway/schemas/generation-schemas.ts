import { INPUT_MODALITIES } from '../../../adapters/normalized-generation';
import { ASSET_KINDS } from '../../../domain/asset-kind';
import { JOB_FAILURE_CLASSES } from '../../../domain/generation-job/failure';
import { GENERATION_JOB_STATES } from '../../../domain/generation-job/lifecycle';

/**
 * Generation_Job route schemas (Requirements 5.1, 5.3, 5.5, 5.7, 6.1, 6.4).
 *
 * The state and failure-class enumerations are imported from the domain rather than
 * restated, so the wire contract and the state machine cannot drift: adding a state
 * without widening the response schema would fail serialisation, and the reverse is
 * impossible.
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

/** Requirement 6.1: classification plus retryability. */
const failureSchema = {
  type: ['object', 'null'],
  properties: {
    classification: { type: 'string', enum: [...JOB_FAILURE_CLASSES] },
    retryable: { type: 'boolean' },
    reason: { type: 'string' },
    detail: { type: ['string', 'null'] },
  },
} as const;

const jobStatusSchema = {
  type: 'object',
  required: ['jobId', 'state', 'engineId', 'queuePosition'],
  properties: {
    jobId: { type: 'string' },
    state: { type: 'string', enum: [...GENERATION_JOB_STATES] },
    engineId: { type: 'string' },
    engineJobId: { type: ['string', 'null'] },
    progressPercent: { type: ['number', 'null'] },
    queuePosition: { type: ['integer', 'null'] },
    estimatedCompletionAtMs: { type: ['integer', 'null'] },
    failure: failureSchema,
    assetIds: { type: 'array', items: { type: 'string' } },
    acceptedAtMs: { type: 'integer' },
    deadlineAtMs: { type: 'integer' },
    attemptsMade: { type: 'integer' },
    retryOfJobId: { type: ['string', 'null'] },
  },
} as const;

/** Requirement 5.1 acceptance body. */
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

export const submitGenerationJobSchema = {
  body: {
    type: 'object',
    required: ['assetKind', 'inputModality', 'durationMs'],
    properties: {
      assetKind: { type: 'string', enum: [...ASSET_KINDS] },
      inputModality: { type: 'string', enum: [...INPUT_MODALITIES] },
      durationMs: { type: 'integer', minimum: 1 },
      prompt: { type: 'string', minLength: 1, maxLength: 2_000 },
      inputAssetIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      seed: { type: ['integer', 'null'] },
      engineId: { type: 'string', minLength: 1, maxLength: 64 },
      resultCount: { type: 'integer', minimum: 1, maximum: 8 },
    },
    additionalProperties: false,
  },
  response: {
    202: acceptanceSchema,
    // Requirement 6.1: an engine that refused every attempt is reported with its
    // classification, not as a generic 500.
    422: errorResponse,
    400: errorResponse,
    402: errorResponse,
    403: errorResponse,
    409: errorResponse,
    429: errorResponse,
    // Requirement 6.6 maintenance notice, produced by the Provider_Registry.
    503: errorResponse,
  },
} as const;

const jobIdParams = {
  type: 'object',
  required: ['jobId'],
  properties: { jobId: { type: 'string', minLength: 1 } },
} as const;

export const getGenerationJobSchema = {
  params: jobIdParams,
  response: { 200: jobStatusSchema, 403: errorResponse, 404: errorResponse },
} as const;

/** Requirement 5.7. */
export const cancelGenerationJobSchema = {
  params: jobIdParams,
  response: { 200: jobStatusSchema, 403: errorResponse, 404: errorResponse, 409: errorResponse },
} as const;

/** Requirement 6.4. */
export const retryGenerationJobSchema = {
  params: jobIdParams,
  response: {
    202: acceptanceSchema,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    422: errorResponse,
    503: errorResponse,
  },
} as const;

/**
 * Requirement 5.4 stream.
 *
 * No response schema: the body is an unbounded `text/event-stream`, and attaching a
 * JSON serialiser to it would be wrong rather than merely unnecessary.
 */
export const streamGenerationJobSchema = {
  params: jobIdParams,
} as const;
