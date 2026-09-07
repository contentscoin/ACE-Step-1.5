import { ASSET_KINDS } from '../../../domain/asset-kind';
import { ASSET_NAME_MAX_LENGTH, ASSET_NAME_MIN_LENGTH } from '../../../domain/audio-asset';
import {
  ASSET_TAG_COUNT_MAX,
  ASSET_TAG_MAX_LENGTH,
  ASSET_TAG_MIN_LENGTH,
  LIBRARY_PAGE_SIZE_MAX,
  LIBRARY_SORT_KEYS,
  PLAYLIST_NAME_MAX_LENGTH,
  PLAYLIST_NAME_MIN_LENGTH,
} from '../../../domain/library/bounds';
import { DOWNLOAD_FORMATS } from '../../../domain/library/download';
import { USAGE_PURPOSES } from '../../../domain/licensing/usage-purpose';
import {
  WAVEFORM_BUCKETS_MAX,
  WAVEFORM_BUCKETS_MIN,
} from '../../../domain/playback/waveform';

/**
 * Library, playback and download schemas (Requirements 11, 12, 13).
 *
 * Every bound is imported from the domain module that owns it rather than written again here.
 * The edge and the service must agree, and the way they agree is by reading the same constant:
 * a schema that said `maximum: 50` would be a second statement of Requirement 11.2 that could
 * drift from `LIBRARY_PAGE_SIZE_MAX` without anything failing.
 *
 * The services validate independently in every case, so a value that slips past a relaxed
 * schema is still refused — with the domain's own violation list, which is richer than a
 * schema error.
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

/** The summary a listing returns; `LibraryAssetSummary` in `domain/library/query.ts`. */
const assetSummary = {
  type: 'object',
  required: [
    'id',
    'ownerId',
    'name',
    'assetKind',
    'caption',
    'lyrics',
    'tags',
    'playCount',
    'createdAtMs',
    'isDeleted',
  ],
  properties: {
    id: { type: 'string' },
    ownerId: { type: 'string' },
    name: { type: 'string' },
    assetKind: { type: 'string' },
    caption: { type: 'string' },
    lyrics: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    playCount: { type: 'integer' },
    createdAtMs: { type: 'integer' },
    isDeleted: { type: 'boolean' },
  },
  additionalProperties: true,
} as const;

const playlist = {
  type: 'object',
  required: ['id', 'ownerId', 'name', 'assetIds', 'createdAtMs', 'updatedAtMs'],
  properties: {
    id: { type: 'string' },
    ownerId: { type: 'string' },
    name: { type: 'string' },
    assetIds: { type: 'array', items: { type: 'string' } },
    createdAtMs: { type: 'integer' },
    updatedAtMs: { type: 'integer' },
  },
} as const;

/** Requirements 11.1–11.4, 11.7, 11.12. The cursor is one opaque string; see `cursor-codec.ts`. */
export const listAssetsSchema = {
  querystring: {
    type: 'object',
    properties: {
      pageSize: { type: 'integer', minimum: 1, maximum: LIBRARY_PAGE_SIZE_MAX },
      sortKey: { type: 'string', enum: [...LIBRARY_SORT_KEYS] },
      assetKind: { type: 'string', enum: [...ASSET_KINDS] },
      search: { type: 'string', maxLength: 200 },
      cursor: { type: 'string', maxLength: 512 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['assets'],
      properties: {
        assets: { type: 'array', items: assetSummary },
        // Absent on the last page — Requirement 11.2's cursor, spent.
        nextCursor: { type: 'string' },
      },
    },
    400: errorResponse,
    401: errorResponse,
  },
} as const;

/**
 * One asset, in full.
 *
 * A wider response than the listing's summary: a detail screen needs the length, the rate, the
 * channel count and the loop flag, and a listing does not. `additionalProperties` stays true on
 * `assetSummary`, so this is the same object with more of it declared rather than a second shape.
 */
export const getAssetSchema = {
  params: assetIdParams,
  response: {
    200: {
      ...assetSummary,
      required: [...assetSummary.required, 'durationMs', 'sampleRate', 'channels', 'isLoop'],
      properties: {
        ...assetSummary.properties,
        durationMs: { type: 'integer' },
        sampleRate: { type: 'integer' },
        channels: { type: 'integer' },
        isLoop: { type: 'boolean' },
        objectKey: { type: ['string', 'null'] },
        deletedAtMs: { type: ['integer', 'null'] },
        stemSourceAssetId: { type: ['string', 'null'] },
      },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
  },
} as const;

/** Requirement 11.5. */
export const renameAssetSchema = {
  params: assetIdParams,
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      // The asset's own bound, not the playlist's — they are both 200 today and they are
      // different rules, so reading the wrong constant would be a latent bug, not a typo.
      name: { type: 'string', minLength: ASSET_NAME_MIN_LENGTH, maxLength: ASSET_NAME_MAX_LENGTH },
    },
    additionalProperties: false,
  },
  response: { 200: assetSummary, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
} as const;

/** Requirement 11.3. */
export const setAssetTagsSchema = {
  params: assetIdParams,
  body: {
    type: 'object',
    required: ['tags'],
    properties: {
      tags: {
        type: 'array',
        maxItems: ASSET_TAG_COUNT_MAX,
        items: { type: 'string', minLength: ASSET_TAG_MIN_LENGTH, maxLength: ASSET_TAG_MAX_LENGTH },
      },
    },
    additionalProperties: false,
  },
  response: { 200: assetSummary, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
} as const;

/** Requirements 11.6, 11.11. */
export const deleteAssetSchema = {
  params: assetIdParams,
  response: { 200: assetSummary, 401: errorResponse, 403: errorResponse, 404: errorResponse },
} as const;

export const restoreAssetSchema = deleteAssetSchema;

/** Requirement 11.13. */
export const listSoundPackAssetsSchema = {
  params: {
    type: 'object',
    required: ['packId'],
    properties: { packId: { type: 'string', minLength: 1, maxLength: 64 } },
  },
  response: {
    200: {
      type: 'object',
      required: ['assets'],
      properties: { assets: { type: 'array', items: assetSummary } },
    },
    401: errorResponse,
  },
} as const;

/** Requirement 11.10. */
export const createPlaylistSchema = {
  body: {
    type: 'object',
    required: ['name', 'assetIds'],
    properties: {
      name: {
        type: 'string',
        minLength: PLAYLIST_NAME_MIN_LENGTH,
        maxLength: PLAYLIST_NAME_MAX_LENGTH,
      },
      assetIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    additionalProperties: false,
  },
  response: { 201: playlist, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
} as const;

export const setPlaylistAssetsSchema = {
  params: {
    type: 'object',
    required: ['playlistId'],
    properties: { playlistId: { type: 'string', minLength: 1, maxLength: 64 } },
  },
  body: {
    type: 'object',
    required: ['assetIds'],
    properties: {
      assetIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    additionalProperties: false,
  },
  response: { 200: playlist, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
} as const;

export const deletePlaylistSchema = {
  params: setPlaylistAssetsSchema.params,
  response: { 204: { type: 'null' }, 401: errorResponse, 403: errorResponse, 404: errorResponse },
} as const;

export const listPlaylistsSchema = {
  response: {
    200: {
      type: 'object',
      required: ['playlists'],
      properties: { playlists: { type: 'array', items: playlist } },
    },
    401: errorResponse,
  },
} as const;

/**
 * Requirements 12.1–12.4, 12.6, 12.8.
 *
 * No response schema: the body is audio, and a serialiser attached to a stream would try to
 * render it as JSON. The headers `planRangeResponse` produced are set on the reply instead.
 */
export const streamAssetSchema = {
  params: assetIdParams,
} as const;

/** Requirements 12.7, 12.8. */
export const assetWaveformSchema = {
  params: assetIdParams,
  querystring: {
    type: 'object',
    properties: {
      buckets: { type: 'integer', minimum: WAVEFORM_BUCKETS_MIN, maximum: WAVEFORM_BUCKETS_MAX },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['assetId', 'buckets', 'durationMs', 'channels'],
      properties: {
        assetId: { type: 'string' },
        buckets: {
          type: 'array',
          items: {
            type: 'object',
            required: ['min', 'max'],
            properties: { min: { type: 'number' }, max: { type: 'number' } },
          },
        },
        durationMs: { type: 'number' },
        channels: { type: 'integer' },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
  },
} as const;

/** Requirement 12.9 — where an elapsed time lands, wrapping for a loop asset. */
export const assetPositionSchema = {
  params: assetIdParams,
  querystring: {
    type: 'object',
    required: ['elapsedMs'],
    properties: { elapsedMs: { type: 'integer', minimum: 0 } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['positionMs', 'pass'],
      properties: {
        positionMs: { type: 'number' },
        pass: { type: 'integer' },
      },
      additionalProperties: true,
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
  },
} as const;

/** Requirements 13.2, 13.8, 13.9. */
export const downloadFormatsSchema = {
  params: assetIdParams,
  response: {
    200: {
      type: 'object',
      required: ['assetId', 'formats'],
      properties: {
        assetId: { type: 'string' },
        formats: { type: 'array', items: { type: 'string', enum: [...DOWNLOAD_FORMATS] } },
      },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
  },
} as const;

/**
 * Requirements 13.1, 13.3, 13.6, 13.7, 13.10, 33.19.
 *
 * No response schema, for the same reason the stream has none: the body is a file.
 */
export const downloadAssetSchema = {
  params: assetIdParams,
  querystring: {
    type: 'object',
    required: ['format'],
    properties: {
      format: { type: 'string', enum: [...DOWNLOAD_FORMATS] },
      usagePurpose: { type: 'string', enum: [...USAGE_PURPOSES] },
    },
    additionalProperties: false,
  },
} as const;

/** Requirement 13.5. */
export const downloadStemsSchema = {
  params: assetIdParams,
  querystring: {
    type: 'object',
    required: ['format'],
    properties: { format: { type: 'string', enum: [...DOWNLOAD_FORMATS] } },
    additionalProperties: false,
  },
} as const;
