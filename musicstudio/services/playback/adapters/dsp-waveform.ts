/**
 * `WaveformPort` over the DSP sidecar, with an in-process cache (roadmap §4.4, slice S6).
 *
 * Requirement 12.7's reduction runs in the worker (`musicstudio_dsp.waveform`); this reads the
 * object, asks for the buckets, and shapes the answer into the domain's `Waveform`.
 *
 * ### The cache is in this process, and that is a v0 choice with a stated cost
 *
 * `services/playback/ports.ts` says a waveform is cached because the reduction reads the whole
 * object and the asset is immutable once stored — so the *value* never needs recomputing, only
 * re-fetching. A table would make that true across restarts and across replicas; a `Map` makes
 * it true within one process. The cost is one recomputation per asset per resolution per
 * process, which is a few hundred milliseconds of DSP time, not a wrong answer. It is bounded
 * so a long-lived gateway cannot accumulate waveforms for every asset it ever served: the
 * oldest entry is evicted past the limit, and an evicted asset simply recomputes.
 *
 * The key is `assetId` *and* bucket count, because 12.7 admits a requested resolution and two
 * resolutions of the same asset are two different drawings.
 */

import type { ComputedWaveform, DspWaveformClient } from '../../generation/adapters/dsp-http-client';
import type { Waveform } from '../../../domain/playback/waveform';
import type { AudioObjectPort, WaveformPort } from '../ports';

import { readWholeObject } from './object-bytes';

/** Enough for a busy gateway's working set; an eviction costs one recomputation. */
export const DEFAULT_WAVEFORM_CACHE_ENTRIES = 512;

export interface DspWaveformOptions {
  readonly objects: AudioObjectPort;
  readonly dsp: DspWaveformClient;
  readonly maxEntries?: number;
}

export class WaveformAudioUnavailable extends Error {
  constructor(readonly objectKey: string) {
    super(`no stored object for waveform: ${objectKey}`);
    this.name = 'WaveformAudioUnavailable';
  }
}

function cacheKey(assetId: string, buckets: number): string {
  return `${assetId}:${String(buckets)}`;
}

function toWaveform(assetId: string, computed: ComputedWaveform): Waveform {
  return {
    assetId,
    buckets: computed.buckets,
    durationMs: computed.durationMs,
    channels: computed.channels,
  };
}

export function createDspWaveformPort(options: DspWaveformOptions): WaveformPort {
  const maxEntries = options.maxEntries ?? DEFAULT_WAVEFORM_CACHE_ENTRIES;
  // Insertion-ordered, so the first key is the oldest — which is what makes the eviction below
  // a single `delete` rather than a scan.
  const cache = new Map<string, Waveform>();

  return {
    async find(assetId, buckets) {
      return cache.get(cacheKey(assetId, buckets)) ?? null;
    },

    async compute(request) {
      const bytes = await readWholeObject(options.objects, request.objectKey);
      // The service checked the asset has an object key; the object itself going missing between
      // that check and this read is a torn state the caller cannot fix by retrying, so it is
      // named rather than reported as an empty waveform.
      if (bytes === null) throw new WaveformAudioUnavailable(request.objectKey);
      return toWaveform(request.assetId, await options.dsp.waveform(bytes, request.buckets));
    },

    async save(waveform, buckets) {
      const key = cacheKey(waveform.assetId, buckets);
      cache.delete(key);
      cache.set(key, waveform);
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    },
  };
}
