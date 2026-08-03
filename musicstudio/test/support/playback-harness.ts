/**
 * In-memory ports for `Playback_Service` (Requirement 12).
 *
 * The object store holds bytes and answers a window out of them, which is the one thing a
 * fake of S3 has to get right here: Requirement 12.3's budget is met by *not* reading the
 * whole object, so a fake that returned everything and let the caller slice would make every
 * range test pass while the real path did the wrong thing. `read` therefore refuses a window
 * it was not asked for — the assertion is in the fake, where a service bug trips it.
 */

import type { TimedLyrics } from '../../domain/lyrics/timed-lyrics';
import type { Waveform } from '../../domain/playback/waveform';
import { bucketBoundaries } from '../../domain/playback/waveform';
import type {
  AssetVisibilityPort,
  AudioObjectMetadata,
  AudioObjectPort,
  PlaybackAsset,
  PlaybackAssetStore,
  WaveformPort,
} from '../../services/playback/ports';

export const ASSET_ID = 'asset-a';
export const OWNER_ID = 'owner-1';
export const STRANGER_ID = 'owner-2';

export function playbackAsset(overrides: Partial<PlaybackAsset> = {}): PlaybackAsset {
  return {
    id: ASSET_ID,
    ownerId: OWNER_ID,
    assetKind: 'song',
    durationMs: 60_000,
    isLoop: false,
    isDeleted: false,
    objectKey: 'audio/asset-a',
    frameCount: 2_880_000,
    ...overrides,
  };
}

export interface InMemoryPlaybackAssetStore extends PlaybackAssetStore {
  readonly rows: Map<string, PlaybackAsset>;
  readonly playCounts: Map<string, number>;
  readonly lyrics: Map<string, TimedLyrics>;
}

export function inMemoryPlaybackAssetStore(
  seed: readonly PlaybackAsset[] = [playbackAsset()],
): InMemoryPlaybackAssetStore {
  const rows = new Map(seed.map((asset) => [asset.id, asset]));
  const playCounts = new Map<string, number>();
  const lyrics = new Map<string, TimedLyrics>();

  return {
    rows,
    playCounts,
    lyrics,
    find: async (assetId) => rows.get(assetId) ?? null,
    incrementPlayCount: async (assetId) => {
      const next = (playCounts.get(assetId) ?? 0) + 1;
      playCounts.set(assetId, next);
      return next;
    },
    timedLyricsFor: async (assetId) => lyrics.get(assetId) ?? null,
  };
}

export interface InMemoryVisibility extends AssetVisibilityPort {
  readonly publicIds: Set<string>;
}

export function inMemoryVisibility(publicIds: readonly string[] = []): InMemoryVisibility {
  const ids = new Set(publicIds);
  return {
    publicIds: ids,
    isPubliclyVisible: async (assetId) => ids.has(assetId),
  };
}

export interface RecordedRead {
  readonly objectKey: string;
  readonly start: number;
  readonly end: number;
}

export interface InMemoryObjectStore extends AudioObjectPort {
  readonly reads: RecordedRead[];
  put(objectKey: string, bytes: Uint8Array, contentType?: string): void;
}

/** A byte at index `i` is `i % 256`, so a window's contents identify its offset. */
export function countingBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = index % 256;
  return bytes;
}

export function inMemoryObjectStore(
  seed: readonly { objectKey: string; bytes: Uint8Array; contentType?: string }[] = [
    { objectKey: 'audio/asset-a', bytes: countingBytes(1_000) },
  ],
): InMemoryObjectStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const reads: RecordedRead[] = [];

  for (const entry of seed) {
    objects.set(entry.objectKey, {
      bytes: entry.bytes,
      contentType: entry.contentType ?? 'audio/flac',
    });
  }

  return {
    reads,
    put: (objectKey, bytes, contentType = 'audio/flac') => {
      objects.set(objectKey, { bytes, contentType });
    },
    head: async (objectKey): Promise<AudioObjectMetadata | null> => {
      const object = objects.get(objectKey);
      if (object === undefined) return null;
      return { contentLength: object.bytes.length, contentType: object.contentType };
    },
    read: async ({ objectKey, start, end }) => {
      const object = objects.get(objectKey);
      if (object === undefined) throw new Error(`no such object: ${objectKey}`);
      if (start < 0 || end >= object.bytes.length || end < start) {
        // See the header: a service that asked for a window outside the object would be
        // asking a real store for a 416, and this is where that surfaces.
        throw new Error(`window out of bounds: ${String(start)}-${String(end)}`);
      }

      reads.push({ objectKey, start, end });
      const window = object.bytes.slice(start, end + 1);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(window);
          controller.close();
        },
      });
    },
  };
}

export interface InMemoryWaveforms extends WaveformPort {
  readonly computed: { assetId: string; buckets: number }[];
  readonly saved: Map<string, Waveform>;
}

/**
 * Computes a waveform from the stored bytes with the same bucket arithmetic the DSP worker
 * uses, so a test can assert the count and the caching without a Celery broker in sight.
 */
export function inMemoryWaveforms(objects?: InMemoryObjectStore): InMemoryWaveforms {
  const computed: { assetId: string; buckets: number }[] = [];
  const saved = new Map<string, Waveform>();
  const key = (assetId: string, buckets: number) => `${assetId}:${String(buckets)}`;

  return {
    computed,
    saved,
    find: async (assetId, buckets) => saved.get(key(assetId, buckets)) ?? null,
    compute: async (request) => {
      computed.push({ assetId: request.assetId, buckets: request.buckets });
      const metadata = await objects?.head(request.objectKey);
      const frameCount = metadata?.contentLength ?? request.buckets;
      const boundaries = bucketBoundaries(frameCount, request.buckets);
      return {
        assetId: request.assetId,
        buckets: Array.from({ length: request.buckets }, (_, index) => ({
          min: -((boundaries[index] ?? 0) % 100) / 100,
          max: ((boundaries[index] ?? 0) % 100) / 100,
        })),
        durationMs: 60_000,
        channels: 2,
      };
    },
    save: async (waveform, buckets) => {
      saved.set(key(waveform.assetId, buckets), waveform);
    },
  };
}

/** Everything a `Playback_Service` needs, wired together. */
export function playbackHarness(
  options: {
    readonly assets?: readonly PlaybackAsset[];
    readonly publicIds?: readonly string[];
    readonly objectLength?: number;
    readonly contentType?: string;
  } = {},
) {
  const assets = inMemoryPlaybackAssetStore(options.assets ?? [playbackAsset()]);
  const visibility = inMemoryVisibility(options.publicIds ?? []);
  const objects = inMemoryObjectStore([
    {
      objectKey: 'audio/asset-a',
      bytes: countingBytes(options.objectLength ?? 1_000),
      contentType: options.contentType ?? 'audio/flac',
    },
  ]);
  const waveforms = inMemoryWaveforms(objects);

  return { assets, visibility, objects, waveforms };
}

/** Collect a stream into one array, for asserting on which bytes were served. */
export async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      total += value.length;
    }
  }

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
