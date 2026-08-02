import {
  ASSET_REVIEW_STATES,
  REVIEW_RESOLUTIONS,
} from '../../../domain/moderation/review-state';
import { REPORT_DETAIL_MAX_LENGTH, REPORT_REASONS } from '../../../services/moderation/report-service';

/**
 * Report intake and review-state schemas (Requirements 16.8, 16.9).
 *
 * Every enumeration is imported rather than restated, so the edge validation and the
 * state machine in `domain/moderation/review-state.ts` cannot drift apart.
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

const assetIdParams = {
  type: 'object',
  required: ['assetId'],
  properties: { assetId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const reviewStateBody = {
  type: 'object',
  required: ['assetId', 'reviewState', 'excludedFromDiscoveryFeed'],
  properties: {
    assetId: { type: 'string' },
    reviewState: { type: 'string', enum: [...ASSET_REVIEW_STATES] },
    excludedFromDiscoveryFeed: { type: 'boolean' },
    openReportCount: { type: 'integer' },
  },
} as const;

/** Requirement 16.8. Unauthenticated: the reporter is a visitor. */
export const submitReportSchema = {
  params: assetIdParams,
  body: {
    type: 'object',
    required: ['reason'],
    properties: {
      reason: { type: 'string', enum: [...REPORT_REASONS] },
      detail: { type: 'string', minLength: 1, maxLength: REPORT_DETAIL_MAX_LENGTH },
    },
    additionalProperties: false,
  },
  response: {
    202: {
      type: 'object',
      required: ['reportId', 'assetId', 'reviewState', 'excludedFromDiscoveryFeed'],
      properties: {
        reportId: { type: 'string' },
        assetId: { type: 'string' },
        reason: { type: 'string' },
        submittedAtMs: { type: 'integer' },
        reviewState: { type: 'string', enum: [...ASSET_REVIEW_STATES] },
        excludedFromDiscoveryFeed: { type: 'boolean' },
        openReportCount: { type: 'integer' },
      },
    },
    400: errorResponse,
    404: errorResponse,
  },
} as const;

/** Requirement 16.9 — lets a caller observe the exclusion the feed will apply. */
export const getReviewStateSchema = {
  params: assetIdParams,
  response: { 200: reviewStateBody, 401: errorResponse, 404: errorResponse },
} as const;

/** Operator resolution. Operator authorisation itself is task 8.2's Admin_Console. */
export const resolveReviewSchema = {
  params: assetIdParams,
  body: {
    type: 'object',
    required: ['resolution'],
    properties: { resolution: { type: 'string', enum: [...REVIEW_RESOLUTIONS] } },
    additionalProperties: false,
  },
  response: { 200: reviewStateBody, 400: errorResponse, 401: errorResponse, 409: errorResponse },
} as const;
