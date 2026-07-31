import { ASSET_KINDS } from '../../../domain/asset-kind';
import {
  DAILY_QUOTA_MAX,
  DAILY_QUOTA_MIN,
  ENGINE_ID_MAX_LENGTH,
  ENGINE_ID_MIN_LENGTH,
  EXECUTION_LOCATIONS,
  MAX_OUTPUT_DURATION_MS_MAX,
  MAX_OUTPUT_DURATION_MS_MIN,
  SAMPLE_RATE_MAX,
  SAMPLE_RATE_MIN,
  SUPPORTED_ASSET_KINDS_MAX,
  SUPPORTED_ASSET_KINDS_MIN,
  SUPPORTED_INPUT_MODALITIES_MAX,
  SUPPORTED_INPUT_MODALITIES_MIN,
} from '../../../adapters/registry/engine-descriptor';
import { LICENSE_URLS_MAX, LICENSE_URLS_MIN } from '../../../adapters/registry/license-descriptor';
import { INPUT_MODALITIES } from '../../../adapters/normalized-generation';
import { ATTRIBUTION_TEXT_MAX_LENGTH } from '../../../domain/provenance';

/**
 * Engine_Descriptor CRUD and engine-list schemas (design §3.2; Requirement 20.1,
 * 20.19).
 *
 * Every bound is imported from the descriptor module rather than restated, so the
 * edge validation and the Provider_Registry validator (Requirement 20.23) can
 * never drift apart. The registry still validates on its own: the HTTP schema
 * exists to reject obvious garbage early, not to be the only check.
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

const licenseDescriptorSchema = {
  type: 'object',
  required: [
    'codeLicenseId',
    'weightLicenseId',
    'commercialUseAllowed',
    'attributionText',
    'licenseUrls',
  ],
  properties: {
    codeLicenseId: { type: 'string', minLength: 1, maxLength: 128 },
    weightLicenseId: { type: 'string', minLength: 1, maxLength: 128 },
    commercialUseAllowed: { type: 'boolean' },
    attributionText: { type: 'string', minLength: 1, maxLength: ATTRIBUTION_TEXT_MAX_LENGTH },
    licenseUrls: {
      type: 'array',
      minItems: LICENSE_URLS_MIN,
      maxItems: LICENSE_URLS_MAX,
      items: { type: 'string', minLength: 1 },
    },
    termsOfServiceUrl: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const engineDescriptorSchema = {
  type: 'object',
  required: [
    'engineId',
    'supportedAssetKinds',
    'supportedInputModalities',
    'maxOutputDurationMs',
    'sampleRate',
    'executionLocation',
    'license',
    'dailyQuota',
  ],
  properties: {
    engineId: {
      type: 'string',
      minLength: ENGINE_ID_MIN_LENGTH,
      maxLength: ENGINE_ID_MAX_LENGTH,
    },
    supportedAssetKinds: {
      type: 'array',
      minItems: SUPPORTED_ASSET_KINDS_MIN,
      maxItems: SUPPORTED_ASSET_KINDS_MAX,
      uniqueItems: true,
      items: { type: 'string', enum: [...ASSET_KINDS] },
    },
    supportedInputModalities: {
      type: 'array',
      minItems: SUPPORTED_INPUT_MODALITIES_MIN,
      maxItems: SUPPORTED_INPUT_MODALITIES_MAX,
      uniqueItems: true,
      items: { type: 'string', enum: [...INPUT_MODALITIES] },
    },
    maxOutputDurationMs: {
      type: 'integer',
      minimum: MAX_OUTPUT_DURATION_MS_MIN,
      maximum: MAX_OUTPUT_DURATION_MS_MAX,
    },
    sampleRate: { type: 'integer', minimum: SAMPLE_RATE_MIN, maximum: SAMPLE_RATE_MAX },
    executionLocation: { type: 'string', enum: [...EXECUTION_LOCATIONS] },
    license: licenseDescriptorSchema,
    licenseComponents: { type: 'array', items: licenseDescriptorSchema },
    dailyQuota: {
      type: 'object',
      required: ['maxRequests', 'maxGpuSeconds'],
      properties: {
        maxRequests: { type: 'integer', minimum: DAILY_QUOTA_MIN, maximum: DAILY_QUOTA_MAX },
        maxGpuSeconds: { type: 'integer', minimum: DAILY_QUOTA_MIN, maximum: DAILY_QUOTA_MAX },
      },
      additionalProperties: false,
    },
    gpuSecondsPerRequest: {
      type: 'integer',
      minimum: DAILY_QUOTA_MIN,
      maximum: DAILY_QUOTA_MAX,
    },
  },
  additionalProperties: false,
} as const;

/** Requirement 20.19: the seven fields the list query must return. */
const engineListingSchema = {
  type: 'object',
  required: [
    'engineId',
    'supportedAssetKinds',
    'maxOutputDurationMs',
    'commercialUseAllowed',
    'attributionText',
    'availableNow',
    'lastCheckedAtMs',
  ],
  properties: {
    engineId: { type: 'string' },
    supportedAssetKinds: { type: 'array', items: { type: 'string' } },
    maxOutputDurationMs: { type: 'integer' },
    commercialUseAllowed: { type: 'boolean' },
    attributionText: { type: 'string' },
    availableNow: { type: 'boolean' },
    lastCheckedAtMs: { type: ['integer', 'null'] },
    lastCheckOutcome: { type: ['string', 'null'] },
    activation: { type: 'string' },
  },
} as const;

export const registerEngineSchema = {
  body: engineDescriptorSchema,
  response: {
    201: {
      type: 'object',
      required: ['engineId', 'activation', 'commercialUseAllowed'],
      properties: {
        engineId: { type: 'string' },
        activation: { type: 'string' },
        missingPricingKeys: { type: 'array', items: { type: 'string' } },
        commercialUseAllowed: { type: 'boolean' },
        commercialUseOverridden: { type: 'boolean' },
        groundingLicenseIds: { type: 'array', items: { type: 'string' } },
        nonCommercialLicenseListVersion: { type: 'integer' },
      },
    },
    400: errorResponse,
    409: errorResponse,
  },
} as const;

export const updateEngineSchema = {
  params: {
    type: 'object',
    required: ['engineId'],
    properties: { engineId: { type: 'string' } },
  },
  body: engineDescriptorSchema,
  response: { 200: engineListingSchema, 400: errorResponse, 404: errorResponse, 409: errorResponse },
} as const;

export const engineIdParamsSchema = {
  type: 'object',
  required: ['engineId'],
  properties: { engineId: { type: 'string' } },
} as const;

export const listEnginesSchema = {
  querystring: {
    type: 'object',
    properties: { assetKind: { type: 'string', enum: [...ASSET_KINDS] } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['engines'],
      properties: { engines: { type: 'array', items: engineListingSchema } },
    },
  },
} as const;

export const getEngineSchema = {
  params: engineIdParamsSchema,
  response: { 200: engineListingSchema, 404: errorResponse },
} as const;

export const deleteEngineSchema = {
  params: engineIdParamsSchema,
  response: {
    204: { type: 'null' },
    404: errorResponse,
    409: errorResponse,
  },
} as const;

export const deactivateEngineSchema = {
  params: engineIdParamsSchema,
  response: { 200: engineListingSchema, 404: errorResponse, 409: errorResponse },
} as const;

/** Requirement 20.9 selection list. */
export const engineSelectionSchema = {
  querystring: {
    type: 'object',
    required: ['assetKind'],
    properties: { assetKind: { type: 'string', enum: [...ASSET_KINDS] } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['assetKind', 'engines'],
      properties: {
        assetKind: { type: 'string' },
        engines: {
          type: 'array',
          items: {
            type: 'object',
            required: ['engineId', 'selectable', 'alternativeEngineIds'],
            properties: {
              engineId: { type: 'string' },
              selectable: { type: 'boolean' },
              unavailableReason: { type: ['string', 'null'] },
              alternativeEngineIds: { type: 'array', items: { type: 'string' } },
              lastCheckedAtMs: { type: ['integer', 'null'] },
              lastCheckOutcome: { type: ['string', 'null'] },
              isDefault: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
} as const;

export const setDefaultEngineSchema = {
  params: {
    type: 'object',
    required: ['assetKind'],
    properties: { assetKind: { type: 'string', enum: [...ASSET_KINDS] } },
  },
  body: {
    type: 'object',
    required: ['engineId'],
    properties: { engineId: { type: 'string' } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['assetKind', 'defaultEngineId'],
      properties: {
        assetKind: { type: 'string' },
        defaultEngineId: { type: 'string' },
        fallbackEngineId: { type: ['string', 'null'] },
      },
    },
    404: errorResponse,
    409: errorResponse,
  },
} as const;
