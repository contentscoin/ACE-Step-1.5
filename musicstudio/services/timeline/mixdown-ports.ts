/**
 * The two seams `Mixdown_Renderer` needs (design §2.3, §6.1).
 *
 * Interfaces rather than clients, for the reason `services/effects/ports.ts` gives: no
 * broker and no object store is reachable from this environment, and Requirements
 * 28.24-28.29 are product-layer rules that must be testable without either.
 *
 * ### Why the render port takes decoded clip references and not a project
 *
 * The worker is handed the **render target set** — Requirements 28.19 and 28.20 have
 * already been applied by `domain/timeline/render-target.ts`. Passing the project instead
 * would put the solo and mute decision on both sides of the seam, and a worker that
 * re-derived it could disagree with the length the caller was promised under 28.25.
 *
 * ### Why the attenuation comes back rather than being recomputed
 *
 * Requirement 28.28 requires the applied figure in the response *and* in the `mix` asset's
 * metadata. Recomputing it here from the peak would describe what the renderer should have
 * done; reporting what it did is what makes the metadata an account of the render.
 */

import type { AssetProvenance } from '../../domain/provenance';

/** Design §3.6: `mix` is produced internally, with no engine call. */
export const MIXDOWN_ENGINE_ID = 'mixdown-renderer';

/** One clip, as the worker needs it: where its audio lives plus the clip's own settings. */
export interface MixdownClipRequest {
  readonly clipId: string;
  readonly objectKey: string;
  readonly startTimeMs: number;
  readonly track: number;
  readonly trimStartMs: number;
  readonly trimEndMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

export interface MixdownTrackRequest {
  readonly track: number;
  readonly volumeDb: number;
  readonly pan: number;
}

/** Requirement 28.27's 렌더링 파라미터, in the shape the reproducibility clause lists them. */
export interface MixdownRenderParams {
  readonly sampleRate: number;
  readonly channels: number;
  readonly peakNormalise: boolean;
}

export interface MixdownRenderRequest {
  readonly clips: readonly MixdownClipRequest[];
  readonly tracks: readonly MixdownTrackRequest[];
  readonly params: MixdownRenderParams;
}

export interface MixdownRenderResult {
  readonly objectKey: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameCount: number;
  readonly durationMs: number;
  /** Requirements 28.24 and 28.28: `0` when the sum fit, the applied figure otherwise. */
  readonly attenuationDb: number;
  readonly peakBefore: number;
}

export interface MixdownRenderPort {
  render(request: MixdownRenderRequest): Promise<MixdownRenderResult>;
}

/** Where a clip's audio lives. Separate from `TimelineAssetCatalogue`, which knows lengths. */
export interface MixdownAudioLocator {
  /** `null` when the asset has no stored audio; the service turns that into a refusal. */
  objectKeyFor(assetId: string): Promise<string | null>;
}

/**
 * Requirement 28.24's `mix` Audio_Asset, plus 28.28's attenuation.
 *
 * `attenuationDb` is a field of its own rather than a key inside `provenance`, because
 * `AssetProvenance` is the licence and generation record (Requirement 33.7) and is
 * write-once; the attenuation is a fact about one render, and folding it in would make
 * every re-render look like a provenance change.
 */
export interface MixdownAssetWriteRequest {
  readonly ownerId: string;
  readonly projectId: string;
  readonly name: string;
  readonly objectKey: string;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly attenuationDb: number;
  readonly provenance: AssetProvenance;
  /** The clips this mix was made from — Requirement 19.7's lineage parents. */
  readonly sourceAssetIds: readonly string[];
}

export interface MixdownAssetWriter {
  /** Returns the stored asset's identifier. */
  save(request: MixdownAssetWriteRequest): Promise<string>;
}
