/**
 * The seams around `Mixdown_Renderer` (Requirements 28.24–28.29; design §2.3, §6.1).
 *
 * Two of them, declared as interfaces for the reason `ports.ts` and
 * `services/effects/ports.ts` give: no broker and no database are reachable here, so every
 * rule of Requirements 28.24–28.29 that is *not* about samples has to be testable without
 * one.
 *
 * ### `MixdownRenderPort` — where the audio actually happens
 *
 * The implementation is `dsp/src/musicstudio_dsp/mixdown.py`, reached through the
 * `musicstudio_dsp.render_mixdown` Celery task. What crosses the seam is deliberately the
 * **already-decided render target set**, not the project:
 *
 * - Requirements 28.19 and 28.20 are decided from stored state by
 *   `domain/timeline/render-target.ts`. A worker that re-derived the selection would be a
 *   second answer to a settled question, and a mute toggled between the decision and the
 *   render would produce a mix nobody asked for.
 * - The clips cross **in summation order** (ascending clip id, Requirement 28.26). The
 *   worker sorts again on arrival. That is not redundant: the ordering is what Property 12
 *   and Property 13 rest on, and neither side should be able to lose it alone.
 *
 * The result reports `sampleRate`, `channels`, `frameCount` *and* `durationMs`, for the
 * reason `EffectProcessingResult` does: Requirement 28.27's invariant is stated over the
 * sample count as well as the values, and a duration alone cannot distinguish 48 000 frames
 * at 48 kHz from 44 100 at 44.1 kHz.
 *
 * It also reports `peakBefore`, `peakAfter` and `attenuationDb` rather than only the
 * attenuated audio. Requirement 28.28 requires the attenuation in the response *and* in the
 * asset's metadata, and only this side writes assets; and reporting the peak the worker
 * actually measured lets the service check the coefficient against
 * `domain/timeline/mixdown.ts`'s arithmetic instead of trusting it.
 *
 * ### `MixdownAssetStore` — where the `mix` asset goes
 *
 * Requirement 28.24 stores the result as an `Asset_Kind = 'mix'` `Audio_Asset`. That row is
 * `db/migrations/0003_audio_asset.sql` and its lineage edges are `0005_lineage.sql`;
 * `0015_timeline_project.sql`'s header declines to add a mixdown column for exactly this
 * reason. There is still no *asset metadata* table — Library_Service (task 5.1) owns that,
 * as `db/migrations/0012`'s header records for dialogue line timings — so the attenuation of
 * Requirement 28.28 travels through this port alongside the asset and the lineage inputs,
 * rather than being dropped until 5.1 arrives.
 *
 * The port takes a fully-formed `AudioAsset`, validated by `validateAudioAsset` before it is
 * handed over, so a store implementation is never the thing that discovers a `mix` asset was
 * malformed.
 */

import type { AudioAsset } from '../../domain/audio-asset';
import type { MixAssetMetadata } from '../../domain/timeline/mixdown';

/** One render target as the worker needs it. Mirrors `MixdownClip` in `mixdown.py`. */
export interface MixdownClipRequest {
  readonly clipId: string;
  readonly assetId: string;
  readonly track: number;
  readonly startTimeMs: number;
  /** Requirement 28.13's derived length. Sent, not recomputed — see `mixdown.py`. */
  readonly playLengthMs: number;
  readonly trimStartMs: number;
  readonly trimEndMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

/** Requirement 28.18's two continuous settings, for one track that has a clip in the mix. */
export interface MixdownTrackRequest {
  readonly track: number;
  readonly volumeDb: number;
  readonly pan: number;
}

/**
 * Requirement 28.27's 렌더링 파라미터, minus the per-clip and per-track values that travel
 * with the clips and tracks.
 */
export interface MixdownRenderParams {
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirement 28.27 lists 피크 정규화 활성 여부 as a parameter, so it is one. */
  readonly normalisePeak: boolean;
}

export interface MixdownRenderRequest {
  readonly projectId: string;
  /** In summation order. See the header. */
  readonly clips: readonly MixdownClipRequest[];
  readonly tracks: readonly MixdownTrackRequest[];
  readonly params: MixdownRenderParams;
  /** Requirement 28.25's computed length, so the worker's own arithmetic is checkable. */
  readonly expectedLengthMs: number;
}

export interface MixdownRenderResult {
  /** Where the rendered audio was written. */
  readonly objectKey: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameCount: number;
  readonly durationMs: number;
  /** The order the worker summed in, echoed so the service can check it. */
  readonly renderedClipIds: readonly string[];
  readonly peakBefore: number;
  readonly peakAfter: number;
  /** Requirement 28.28's 감쇠량. `0` when the peak was already at or below 1.0 (28.24). */
  readonly attenuationDb: number;
  readonly normalised: boolean;
}

export interface MixdownRenderPort {
  render(request: MixdownRenderRequest): Promise<MixdownRenderResult>;
}

/** What is written when a mixdown succeeds. One call, so the three cannot half-happen. */
export interface StoredMix {
  readonly asset: AudioAsset;
  /** Requirement 19.6/19.7: the `mix`'s direct input assets, with derivation `mixdown`. */
  readonly sourceAssetIds: readonly string[];
  readonly metadata: MixAssetMetadata;
  readonly objectKey: string;
}

export interface MixdownAssetStore {
  save(mix: StoredMix): Promise<void>;
}
