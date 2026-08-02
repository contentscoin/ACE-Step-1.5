/**
 * The seams around `Playback_Service` (design §2.3).
 *
 * ### Why the object store returns a window and not a file
 *
 * Requirement 12.3 gives a seek one second to start sending. An object port that returned
 * whole objects would meet that on a short asset and miss it on a long one, and the miss
 * would be invisible in every test that used a short one. The port therefore takes the
 * byte window `resolveRange` produced, which is the shape S3 and a CDN already speak
 * (`Range` on a GET), so the one-second budget is a property of the call rather than of
 * how much the caller happens to slice afterwards.
 *
 * ### Why visibility is a port and not a column
 *
 * Requirement 12.6 gates a private asset's stream, and Requirement 14 — task 5.3 — is what
 * *makes* an asset public or private. `services/moderation/report-service.ts` already
 * declares the same question as a port for the same reason, and this one matches its shape
 * so that 5.3 has one flag to implement rather than two to keep in step.
 */

import type { AssetKind } from '../../domain/asset-kind';
import type { TimedLyrics } from '../../domain/lyrics/timed-lyrics';
import type { Waveform } from '../../domain/playback/waveform';

/** What playback needs to know about an asset. Narrower than the library's record. */
export interface PlaybackAsset {
  readonly id: string;
  readonly ownerId: string;
  readonly assetKind: AssetKind;
  readonly durationMs: number;
  readonly isLoop: boolean;
  readonly isDeleted: boolean;
  /** `null` once Requirement 11.8 has purged the audio. */
  readonly objectKey: string | null;
  readonly frameCount: number;
}

export interface PlaybackAssetStore {
  find(assetId: string): Promise<PlaybackAsset | null>;
  /** Requirement 12.4. Returns the count after the increment. */
  incrementPlayCount(assetId: string): Promise<number>;
  timedLyricsFor(assetId: string): Promise<TimedLyrics | null>;
}

/** Requirement 12.6. See the header: task 5.3 owns the stored flag. */
export interface AssetVisibilityPort {
  isPubliclyVisible(assetId: string): Promise<boolean>;
}

export interface AudioObjectMetadata {
  readonly contentLength: number;
  readonly contentType: string;
}

export interface AudioObjectPort {
  /** `null` when the object does not exist, which the service reports as unavailable. */
  head(objectKey: string): Promise<AudioObjectMetadata | null>;
  /**
   * The bytes of one window, `end` inclusive.
   *
   * A stream rather than a buffer: Requirement 12.1 hands the client a stream, and
   * materialising a whole window first would put its size into memory for no gain.
   */
  read(request: {
    readonly objectKey: string;
    readonly start: number;
    readonly end: number;
  }): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Requirement 12.7's waveform.
 *
 * Cached by asset and bucket count, because the reduction reads the whole object and a
 * waveform does not change — the asset is immutable once stored (design §1.2's
 * non-destructive editing). A miss computes in the DSP worker.
 */
export interface WaveformPort {
  find(assetId: string, buckets: number): Promise<Waveform | null>;
  compute(request: {
    readonly assetId: string;
    readonly objectKey: string;
    readonly buckets: number;
  }): Promise<Waveform>;
  save(waveform: Waveform, buckets: number): Promise<void>;
}
