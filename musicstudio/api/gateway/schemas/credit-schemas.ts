import { ASSET_KINDS } from '../../../domain/asset-kind';

/**
 * Credit usage and price-estimate schemas (Requirements 2.7, 2.9–2.11).
 *
 * Bounds are stated once here for the transport edge; the service validates
 * independently, so an out-of-range value that slips past a relaxed schema is
 * still rejected by Credit_Service rather than silently charged.
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

const assetKindCounts = {
  type: 'object',
  additionalProperties: { type: 'integer' },
} as const;

/** Requirement 2.7: balance, month-to-date credits, remaining monthly jobs. */
export const creditUsageSchema = {
  response: {
    200: {
      type: 'object',
      required: [
        'accountId',
        'planId',
        'balance',
        'creditsUsedThisMonth',
        'remainingMonthlyJobs',
        'monthlyJobLimit',
        'jobsInFlight',
        'concurrentJobLimit',
      ],
      properties: {
        accountId: { type: 'string' },
        planId: { type: 'string' },
        balance: { type: 'integer' },
        creditsUsedThisMonth: { type: 'integer' },
        remainingMonthlyJobs: { type: 'integer' },
        monthlyJobLimit: { type: 'integer' },
        jobsInFlight: { type: 'integer' },
        concurrentJobLimit: { type: 'integer' },
        periodStartMs: { type: 'integer' },
        remainingMonthlyAssetsByKind: assetKindCounts,
      },
    },
    401: errorResponse,
  },
} as const;

/**
 * Requirements 2.9–2.11: what a request would cost, before anything is charged.
 *
 * Exists so a client can show a price without submitting a job, and it is the
 * route where an unpriced `Asset_Kind × Engine` combination surfaces as 400 with
 * the combination identifier.
 */
export const creditEstimateSchema = {
  querystring: {
    type: 'object',
    required: ['assetKind', 'engineId', 'durationMs'],
    properties: {
      assetKind: { type: 'string', enum: [...ASSET_KINDS] },
      engineId: { type: 'string', minLength: 1, maxLength: 64 },
      durationMs: { type: 'integer', minimum: 0, maximum: 3_600_000 },
      outputCount: { type: 'integer', minimum: 1, maximum: 78, default: 1 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['pricingKey', 'amount', 'assetKind', 'engineId', 'durationMs', 'outputCount'],
      properties: {
        pricingKey: { type: 'string' },
        amount: { type: 'integer' },
        assetKind: { type: 'string' },
        engineId: { type: 'string' },
        durationMs: { type: 'integer' },
        outputCount: { type: 'integer' },
        balance: { type: 'integer' },
        sufficient: { type: 'boolean' },
      },
    },
    400: errorResponse,
    401: errorResponse,
  },
} as const;
