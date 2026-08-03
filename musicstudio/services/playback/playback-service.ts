/**
 * Playback_Service — streaming, seeking, play counts, waveforms, lyric sync.
 *
 * Requirements 12.1-12.9, design §2.3.
 *
 * ### The order of the gate and the counter
 *
 * Requirement 12.4 increments the play count "WHEN 재생이 시작되면", and 12.6 gates a
 * private asset. The gate runs first, and the counter runs only for a request that will be
 * answered — otherwise a stranger could inflate an owner's play count by requesting a
 * stream they are refused, and the number Requirement 11.4 sorts by would be a record of
 * failed attempts.
 *
 * The counter also runs only for a request with **no `Range` header, or one starting at
 * byte 0**. A player seeking through a track issues a range request per seek; counting each
 * would make one listen register as a dozen plays. "Playback started" is the request that
 * begins at the beginning.
 */

import { positionAt, type LoopPosition } from '../../domain/playback/loop';
import { activeLineAt, type ActiveLyricLine } from '../../domain/playback/lyrics-sync';
import { planRangeResponse, resolveRange } from '../../domain/playback/range';
import {
  isWaveformBucketCount,
  resolveBucketCount,
  WAVEFORM_BUCKETS_DEFAULT,
  type Waveform,
} from '../../domain/playback/waveform';
import {
  playbackAssetNotFound,
  playbackAssetPrivate,
  playbackAudioUnavailable,
  playbackRangeUnsatisfiable,
  playbackWaveformRequestInvalid,
} from './errors';
import type {
  AssetVisibilityPort,
  AudioObjectPort,
  PlaybackAsset,
  PlaybackAssetStore,
  WaveformPort,
} from './ports';

export interface PlaybackServiceOptions {
  readonly assets: PlaybackAssetStore;
  readonly visibility: AssetVisibilityPort;
  readonly objects: AudioObjectPort;
  readonly waveforms: WaveformPort;
}

export interface StreamRequest {
  readonly assetId: string;
  /** `null` for an anonymous request, which only a public asset answers. */
  readonly requesterId: string | null;
  readonly rangeHeader?: string | null;
}

export interface StreamResponse {
  readonly status: 200 | 206;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength: number;
  /** Requirement 12.4's counter, after this request. `null` when it did not count. */
  readonly playCount: number | null;
}

export function createPlaybackService(options: PlaybackServiceOptions) {
  const { assets, visibility, objects, waveforms } = options;

  /**
   * Requirements 12.1 and 12.6's gate.
   *
   * A deleted asset is refused as absent — Requirement 11.7 removes it from listings, and a
   * stream that still played it would make the deletion cosmetic.
   */
  async function loadPlayable(assetId: string, requesterId: string | null): Promise<PlaybackAsset> {
    const asset = await assets.find(assetId);
    if (asset === null || asset.isDeleted) throw playbackAssetNotFound(assetId);

    if (asset.ownerId === requesterId) return asset;
    if (await visibility.isPubliclyVisible(assetId)) return asset;
    throw playbackAssetPrivate(assetId);
  }

  return {
    /** Requirements 12.1, 12.2, 12.3, 12.4, 12.6, 12.8. */
    async stream(request: StreamRequest): Promise<StreamResponse> {
      const asset = await loadPlayable(request.assetId, request.requesterId);
      if (asset.objectKey === null) throw playbackAudioUnavailable(asset.id);

      const metadata = await objects.head(asset.objectKey);
      if (metadata === null) throw playbackAudioUnavailable(asset.id);

      const resolution = resolveRange(request.rangeHeader, metadata.contentLength);
      if (resolution.kind === 'unsatisfiable') {
        throw playbackRangeUnsatisfiable(asset.id, metadata.contentLength);
      }

      const plan = planRangeResponse(
        request.rangeHeader,
        metadata.contentLength,
        metadata.contentType,
      );

      // Requirement 12.3: the window goes to the store, so the first byte comes from the
      // requested offset rather than from the front of the object.
      const body = await objects.read({
        objectKey: asset.objectKey,
        start: plan.start,
        end: plan.end,
      });

      // Requirement 12.4 — see the header on why not every range counts.
      const counts = plan.start === 0;
      const playCount = counts ? await assets.incrementPlayCount(asset.id) : null;

      return {
        status: plan.status === 416 ? 200 : plan.status,
        headers: plan.headers,
        body,
        contentLength: plan.contentLength,
        playCount,
      };
    },

    /** Requirements 12.7, 12.8. Computed once per resolution and cached; see the port. */
    async waveform(
      assetId: string,
      requesterId: string | null,
      buckets?: number,
    ): Promise<Waveform> {
      if (buckets !== undefined && !isWaveformBucketCount(buckets)) {
        throw playbackWaveformRequestInvalid(buckets);
      }

      const asset = await loadPlayable(assetId, requesterId);
      if (asset.objectKey === null) throw playbackAudioUnavailable(asset.id);

      const resolved = resolveBucketCount(buckets ?? WAVEFORM_BUCKETS_DEFAULT, asset.frameCount);
      const cached = await waveforms.find(assetId, resolved);
      if (cached !== null) return cached;

      const computed = await waveforms.compute({
        assetId,
        objectKey: asset.objectKey,
        buckets: resolved,
      });
      await waveforms.save(computed, resolved);
      return computed;
    },

    /**
     * Requirement 12.5: the lyric line showing at a position.
     *
     * Returns `null` both for an asset with no `Timed_Lyrics` and for a position before the
     * first line. The two are different states and neither shows a line, which is what the
     * caller acts on; a caller that needs to tell them apart can ask whether the asset has
     * lyrics at all.
     */
    async lyricLineAt(
      assetId: string,
      requesterId: string | null,
      positionMs: number,
    ): Promise<ActiveLyricLine | null> {
      await loadPlayable(assetId, requesterId);
      const timedLyrics = await assets.timedLyricsFor(assetId);
      return timedLyrics === null ? null : activeLineAt(timedLyrics, positionMs);
    },

    /** Requirement 12.9: where an elapsed time lands, wrapping for a loop asset. */
    async positionAfter(
      assetId: string,
      requesterId: string | null,
      elapsedMs: number,
    ): Promise<LoopPosition> {
      const asset = await loadPlayable(assetId, requesterId);
      return positionAt(elapsedMs, asset.durationMs, asset.isLoop);
    },
  };
}
