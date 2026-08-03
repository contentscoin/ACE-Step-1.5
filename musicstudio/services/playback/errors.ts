/**
 * The Playback_Service's rejections.
 *
 * The one judgement call is `playbackAssetPrivate`, and it is recorded in
 * `services/generation/errors.ts` beside the code: a private asset is 404, not 403, because
 * a stream URL is reachable without a session and a 403 would confirm the asset exists.
 * Requirement 12.6 fixes neither code, unlike Requirement 11.9, which does.
 */

import {
  WAVEFORM_BUCKETS_MAX,
  WAVEFORM_BUCKETS_MIN,
} from '../../domain/playback/waveform';
import { unsatisfiableContentRangeHeader } from '../../domain/playback/range';
import { GenerationError } from '../generation/errors';

export function playbackAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(404, 'playback_asset_not_found', 'No such Audio_Asset.', {
    assetId,
  });
}

/** Requirement 12.6. Deliberately indistinguishable from "no such asset" to a stranger. */
export function playbackAssetPrivate(assetId: string): GenerationError {
  return new GenerationError(404, 'playback_asset_private', 'No such Audio_Asset.', {
    assetId,
  });
}

/**
 * Requirement 12.2's 416.
 *
 * Carries the `Content-Range` RFC 7233 requires on a 416 — `bytes * /length` — because a
 * client that asked past the end learns the size from it and can ask again. A 416 without
 * it leaves the client with nothing to correct.
 */
export function playbackRangeUnsatisfiable(
  assetId: string,
  contentLength: number,
): GenerationError {
  return new GenerationError(
    416,
    'playback_range_unsatisfiable',
    'The requested range is not satisfiable.',
    {
      assetId,
      contentLength,
      headers: { 'content-range': unsatisfiableContentRangeHeader(contentLength) },
    },
  );
}

export function playbackAudioUnavailable(assetId: string): GenerationError {
  return new GenerationError(
    409,
    'playback_audio_unavailable',
    'This Audio_Asset has no stored audio.',
    { assetId },
  );
}

export function playbackWaveformRequestInvalid(requested: unknown): GenerationError {
  return new GenerationError(
    400,
    'playback_waveform_request_invalid',
    'The requested waveform resolution is not valid.',
    {
      requested: String(requested),
      expected: `${String(WAVEFORM_BUCKETS_MIN)}..${String(WAVEFORM_BUCKETS_MAX)}`,
    },
  );
}
