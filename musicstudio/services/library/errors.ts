/**
 * The Library_Service's rejections.
 *
 * All are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no new
 * branch — the arrangement `services/timeline/errors.ts` describes.
 *
 * Two of Requirement 11's clauses fix a status code, and they are the reason the ownership
 * pair below is split the way it is:
 *
 * - **11.9** — "소유하지 않은 Audio_Asset에 대해 변경 또는 삭제를 요청하면 403". Stated,
 *   so a foreign asset is 403 and not 404, even though 404 would leak less. The requirement
 *   settles the trade-off; this module does not re-open it.
 * - **13.4** — a refusal must carry "필요한 요금제", so the payload is not optional.
 */

import type { DownloadFormat } from '../../domain/library/download';
import type { DownloadRefusalCode } from '../../domain/library/download';
import type { LibraryQueryViolation } from '../../domain/library/query';
import type { TagViolation } from '../../domain/library/tags';
import { GenerationError } from '../generation/errors';

export function libraryAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(404, 'library_asset_not_found', 'No such Audio_Asset.', {
    assetId,
  });
}

/** Requirement 11.9, which names the status code. */
export function libraryAssetForbidden(assetId: string): GenerationError {
  return new GenerationError(
    403,
    'library_asset_forbidden',
    'This Audio_Asset belongs to another account.',
    { assetId },
  );
}

export function libraryQueryInvalid(
  violations: readonly LibraryQueryViolation[],
): GenerationError {
  return new GenerationError(
    400,
    'library_query_invalid',
    'The library listing request is not valid.',
    { violations },
  );
}

export function libraryTagsInvalid(violations: readonly TagViolation[]): GenerationError {
  return new GenerationError(400, 'library_tags_invalid', 'The tag set is not valid.', {
    violations,
  });
}

export function libraryPlaylistNotFound(playlistId: string): GenerationError {
  return new GenerationError(404, 'library_playlist_not_found', 'No such playlist.', {
    playlistId,
  });
}

export function libraryPlaylistForbidden(playlistId: string): GenerationError {
  return new GenerationError(
    403,
    'library_playlist_forbidden',
    'This playlist belongs to another account.',
    { playlistId },
  );
}

export function libraryPlaylistInvalid(
  violation: string,
  detail: Readonly<Record<string, unknown>> = {},
): GenerationError {
  return new GenerationError(400, 'library_playlist_invalid', 'The playlist is not valid.', {
    violation,
    ...detail,
  });
}

/**
 * Requirements 13.2, 13.4, 13.9.
 *
 * 402 for the entitlement refusal and 400 for the two format refusals: a plan gate is a
 * payment-shaped answer that the same request would pass under a different plan, while an
 * unknown format is a malformed request. `Credit_Service` already answers 402 for the other
 * "your plan does not cover this", so a client has one status to recognise.
 */
export function libraryDownloadRefused(
  refusal: DownloadRefusalCode,
  detail: {
    readonly assetId: string;
    readonly requestedFormat: unknown;
    readonly offeredFormats?: readonly DownloadFormat[];
    readonly requiredPlanIds?: readonly string[];
  },
): GenerationError {
  const status = refusal === 'download_lossless_not_entitled' ? 402 : 400;
  return new GenerationError(status, 'library_download_refused', 'The download was refused.', {
    refusal,
    ...detail,
  });
}

export function libraryAudioUnavailable(assetId: string): GenerationError {
  return new GenerationError(
    409,
    'library_audio_unavailable',
    'This Audio_Asset has no stored audio.',
    { assetId },
  );
}
