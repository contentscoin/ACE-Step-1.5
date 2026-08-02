/**
 * Mixdown_Renderer — Requirements 28.24, 28.25, 28.28, 28.29 (design §6.1-§6.3).
 *
 * The product-layer half of the renderer. The arithmetic is Python's
 * (`dsp/src/musicstudio_dsp/mixdown.py`); what happens here is everything that decides
 * *whether* and *with what* the worker is called, and what becomes of its output:
 *
 * 1. ownership, through the same check every Timeline_Service method funnels through;
 * 2. Requirement 28.29's refusal, taken before any audio is located, so a project with
 *    nothing to render costs no lookups and — the clause's own requirement — is left
 *    completely untouched;
 * 3. Requirement 28.25's expected length, computed here and checked against what came
 *    back, so a worker that drifted is caught at the seam rather than in a stored asset;
 * 4. Requirement 28.24's `mix` Audio_Asset, carrying 28.28's attenuation.
 *
 * Credit for the render is **not** deducted here. Requirement 2.12 and its 믹스다운 단가 ×
 * 렌더링 길이 belong to task 4.3, which owns clip effects and the pricing that goes with
 * them; charging in two places would be the kind of duplicate answer §1.4.3 warns about.
 */

import {
  isReportableAttenuationDb,
  MIXDOWN_LENGTH_TOLERANCE_MS,
  planMixdown,
} from '../../domain/timeline/mixdown';
import type { TimelineClip, TimelineProject } from '../../domain/timeline/project';
import { GenerationError } from '../generation/errors';
import {
  MIXDOWN_ENGINE_ID,
  type MixdownAssetWriter,
  type MixdownAudioLocator,
  type MixdownClipRequest,
  type MixdownRenderParams,
  type MixdownRenderPort,
  type MixdownRenderResult,
  type MixdownTrackRequest,
} from './mixdown-ports';
import { timelineProjectForbidden, timelineProjectNotFound } from './errors';
import type { TimelineProjectStore } from './ports';
import type { AssetProvenance } from '../../domain/provenance';

export const DEFAULT_RENDER_PARAMS: MixdownRenderParams = {
  sampleRate: 48_000,
  channels: 2,
  peakNormalise: true,
};

export interface MixdownRequest {
  readonly ownerId: string;
  readonly projectId: string;
  readonly name?: string;
  readonly params?: Partial<MixdownRenderParams>;
  /** The licence record the `mix` asset carries; the caller folds it (design §4.3). */
  readonly provenance: AssetProvenance;
}

export interface MixdownResponse {
  readonly assetId: string;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirements 28.24, 28.28. `0` means the sum fit and nothing was scaled. */
  readonly attenuationDb: number;
  readonly renderedClipIds: readonly string[];
}

export interface MixdownRendererOptions {
  readonly store: TimelineProjectStore;
  readonly render: MixdownRenderPort;
  readonly audio: MixdownAudioLocator;
  readonly assets: MixdownAssetWriter;
}

/** Requirement 28.29. Carries the exclusions so a client can see *why* nothing was left. */
export function mixdownNoRenderTarget(
  projectId: string,
  excluded: readonly { clipId: string; reason: string }[],
): GenerationError {
  return new GenerationError(
    409,
    'mixdown_no_render_target',
    'No clip would be rendered: the project has none, or solo and mute excluded them all.',
    { projectId, reason: 'no_render_target', excluded },
  );
}

export function mixdownAudioUnavailable(assetId: string, clipId: string): GenerationError {
  return new GenerationError(
    409,
    'mixdown_audio_unavailable',
    'A clip references an Audio_Asset with no stored audio.',
    { assetId, clipId },
  );
}

export function createMixdownRenderer(options: MixdownRendererOptions) {
  const { store, render, audio, assets } = options;

  return {
    async renderProject(request: MixdownRequest): Promise<MixdownResponse> {
      const record = await store.load(request.projectId);
      if (record === null) throw timelineProjectNotFound(request.projectId);
      if (record.project.ownerId !== request.ownerId) {
        throw timelineProjectForbidden(request.projectId);
      }

      const project = record.project;
      const plan = planMixdown(project);

      // Requirement 28.29, before anything else touches the project or storage.
      if (plan.rejection !== null) {
        throw mixdownNoRenderTarget(request.projectId, plan.target.excluded);
      }

      const params = { ...DEFAULT_RENDER_PARAMS, ...request.params };
      const clips = await locateClips(project, plan.target.clips);
      const result = await render.render({
        clips,
        tracks: tracksInPlay(project, plan.target.clips),
        params,
      });

      assertLength(result, plan.lengthMs);
      assertAttenuation(result);

      const assetId = await assets.save({
        ownerId: request.ownerId,
        projectId: request.projectId,
        name: request.name ?? `${project.name} (mix)`,
        objectKey: result.objectKey,
        durationMs: Math.round(result.durationMs),
        sampleRate: result.sampleRate,
        channels: result.channels,
        // Requirement 28.28: recorded on the asset, not only in the response.
        attenuationDb: result.attenuationDb,
        provenance: { ...request.provenance, engineId: MIXDOWN_ENGINE_ID },
        sourceAssetIds: [...new Set(plan.target.clips.map((clip) => clip.assetId))],
      });

      return {
        assetId,
        durationMs: Math.round(result.durationMs),
        sampleRate: result.sampleRate,
        channels: result.channels,
        attenuationDb: result.attenuationDb,
        renderedClipIds: plan.target.clips.map((clip) => clip.id),
      };
    },
  };

  async function locateClips(
    project: TimelineProject,
    clips: readonly TimelineClip[],
  ): Promise<readonly MixdownClipRequest[]> {
    const located: MixdownClipRequest[] = [];
    for (const clip of clips) {
      const objectKey = await audio.objectKeyFor(clip.assetId);
      if (objectKey === null) throw mixdownAudioUnavailable(clip.assetId, clip.id);
      located.push({
        clipId: clip.id,
        objectKey,
        startTimeMs: clip.startTimeMs,
        track: clip.track,
        trimStartMs: clip.trimStartMs,
        trimEndMs: clip.trimEndMs,
        gainDb: clip.gainDb,
        fadeInMs: clip.fadeInMs,
        fadeOutMs: clip.fadeOutMs,
      });
    }
    return located;
  }
}

/**
 * Only the tracks that carry a render target clip.
 *
 * A project always has 32 tracks (Requirement 28.11) and typically uses a few. Sending all
 * of them would put 30 settings the renderer has nothing to apply to on every request, and
 * would make the payload grow with a constant rather than with the work.
 */
function tracksInPlay(
  project: TimelineProject,
  clips: readonly TimelineClip[],
): readonly MixdownTrackRequest[] {
  const indices = [...new Set(clips.map((clip) => clip.track))].sort((a, b) => a - b);
  return indices.flatMap((index) => {
    const track = project.tracks[index];
    if (track === undefined) return [];
    return [{ track: index, volumeDb: track.volumeDb, pan: track.pan }];
  });
}

/**
 * Requirement 28.25, checked against what the worker returned.
 *
 * An invariant is only an invariant if something asserts it, and the two sides compute the
 * length by different routes — milliseconds here, frames there. A mismatch means the seam
 * has drifted, and storing the asset anyway would put the drift beyond reach.
 */
function assertLength(result: MixdownRenderResult, expectedMs: number): void {
  const deviation = Math.abs(result.durationMs - expectedMs);
  if (deviation > MIXDOWN_LENGTH_TOLERANCE_MS) {
    throw new GenerationError(
      502,
      'mixdown_render_invalid',
      'The rendered mixdown length does not match the project.',
      { expectedMs, actualMs: result.durationMs, toleranceMs: MIXDOWN_LENGTH_TOLERANCE_MS },
    );
  }
}

/** Requirements 28.24 and 28.28: `0`, or a figure inside the reporting band. */
function assertAttenuation(result: MixdownRenderResult): void {
  if (!isReportableAttenuationDb(result.attenuationDb)) {
    throw new GenerationError(
      502,
      'mixdown_render_invalid',
      'The renderer reported an attenuation outside the permitted band.',
      { attenuationDb: result.attenuationDb, maxDb: 40 },
    );
  }
}
