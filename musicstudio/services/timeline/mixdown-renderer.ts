/**
 * `Mixdown_Renderer` — the product-layer half of Requirements 28.24–28.29 (design §6.1–§6.3).
 *
 * The samples are rendered in Python (`dsp/src/musicstudio_dsp/mixdown.py`), reached across
 * `MixdownRenderPort`. This module is everything that cannot be done there: reading the
 * project, refusing an empty render, checking that what came back keeps the invariants the
 * requirement states, and storing the result as an `Asset_Kind = 'mix'` `Audio_Asset` with
 * the attenuation recorded.
 *
 * ### Four things it does, in an order that matters
 *
 * **1. Plan before spending anything.** `planMixdown` (Requirements 28.19, 28.20, 28.25,
 * 28.26, 28.29) is pure and cheap. An empty target set is refused here, before a task is
 * queued and before a credit is spent, which is what makes Requirement 28.29's "Timeline_
 * Project 상태를 변경하지 않는다" true by construction rather than by careful rollback: this
 * function has written nothing at the point it throws.
 *
 * **2. Refuse what cannot be stored, before rendering it.** Requirement 19.11 caps an asset
 * at an hour and 19.6 caps its direct inputs at 64, and a `Timeline_Project` can exceed both
 * (Requirement 28.5 allows 500 clips). Discovering that *after* an hour-long render would
 * charge the user for audio that is then thrown away.
 *
 * **3. Check the render against the clauses, do not assume it.** Requirements 28.24–28.27
 * are stated as invariants of what the renderer produces. A result that breaches one is this
 * service failing to keep its own promise, and saying so is more useful than storing a mix
 * whose length or peak nobody checked — the same stance `services/effects/effects-service.ts`
 * takes about Requirements 29.30 and 29.32. Four things are checked: the length tolerance,
 * the summation order, the peak window, and the requested shape.
 *
 * **4. Store the asset, the lineage and the attenuation in one call.** Requirement 28.24
 * stores a `mix` asset; Requirement 19.7 makes its lineage mandatory; Requirement 28.28 puts
 * the attenuation in the asset's metadata. `MixdownAssetStore.save` takes all three together
 * so they cannot half-happen.
 *
 * ### What it deliberately does not do
 *
 * - **It does not fold the commercial-use flag.** Requirement 33.20 covers 믹스다운 explicitly
 *   and `domain/commercial-use.ts` already implements the fold; Property 18 and task 6.3 own
 *   it. So the provenance and the folded flag arrive *with the request* from the caller that
 *   knows the inputs' licences, and `validateAudioAsset` enforces the one rule that can be
 *   checked locally — a mix may not claim commercial use its own provenance does not permit.
 *   A second fold here would be a second answer to Requirement 33.21's invariant.
 * - **It does not deduct credits.** Requirement 2.12's 믹스다운 단가 × 렌더링 길이 is task
 *   4.3's, and `renderProject` returns the rendered length so that the deduction has a number
 *   to work from.
 * - **It does not apply clip effects.** Requirements 29.31 and 29.32 and design §6.3's tail
 *   policy are task 4.3's. The chain slot exists in the DSP layer (`MixdownClip.effect_chain`)
 *   and `TimelineClip` has no chain field yet, so nothing is dropped: there is nothing to
 *   drop until 4.3 adds it.
 */

import { randomUUID } from 'node:crypto';

import {
  ASSET_DURATION_MAX_MS,
  validateAudioAsset,
  type AudioAsset,
} from '../../domain/audio-asset';
import { MAX_PARENTS_PER_ASSET } from '../../domain/lineage/limits';
import type { AssetProvenance } from '../../domain/provenance';
import {
  MIXDOWN_REPRODUCIBILITY_RUNS,
  mixdownLengthWithinTolerance,
  normalisedPeakWithinWindow,
  peakNormalisation,
  planMixdown,
  type MixAssetMetadata,
  type MixdownPlan,
} from '../../domain/timeline/mixdown';
import { clipPlayLengthMs, type TimelineProject } from '../../domain/timeline/project';
import { systemClock, type Clock } from '../clock';

import {
  mixdownAssetInvalid,
  mixdownInputLimitExceeded,
  mixdownInvariantBreached,
  mixdownLengthUnsupported,
  mixdownNoRenderTarget,
  timelineProjectForbidden,
  timelineProjectNotFound,
} from './errors';
import type {
  MixdownAssetStore,
  MixdownClipRequest,
  MixdownRenderParams,
  MixdownRenderPort,
  MixdownRenderResult,
  MixdownTrackRequest,
} from './mixdown-ports';
import type { TimelineProjectStore } from './ports';

/** Design §5.1's canonical output. Requirement 19.4 stores nothing else. */
export const DEFAULT_MIXDOWN_PARAMS: MixdownRenderParams = {
  sampleRate: 48_000,
  channels: 2,
  normalisePeak: true,
};

/**
 * The `engine_id` recorded for audio this product rendered itself.
 *
 * Requirement 19.12 allows the field to carry an upload-source marker rather than an engine,
 * which is the slot a mixdown falls into: no generation engine touched it. A marker rather
 * than the empty string because Requirement 19.15 requires the field to be present, and
 * rather than borrowing a clip's engine id because a mix may draw on several engines and
 * naming one of them would misreport where the audio came from.
 */
export const MIXDOWN_RENDERER_ENGINE_ID = 'musicstudio-mixdown';

export interface MixdownRendererOptions {
  readonly store: TimelineProjectStore;
  readonly render: MixdownRenderPort;
  readonly mixAssets: MixdownAssetStore;
  readonly clock?: Clock;
  /** Injectable so tests get stable asset ids. */
  readonly generateId?: () => string;
}

export interface RenderMixdownRequest {
  readonly ownerId: string;
  readonly projectId: string;
  /** Defaults to `DEFAULT_MIXDOWN_PARAMS`; Requirement 28.27 makes these part of the render. */
  readonly params?: Partial<MixdownRenderParams>;
  /** Defaults to the project's name. Requirement 19.15 bounds it at 1–200 characters. */
  readonly assetName?: string;
  /** Requirement 33.7's immutable record. Supplied, not invented — see the header. */
  readonly provenance: AssetProvenance;
  /** Requirement 33.20's folded flag, computed by the caller that knows the inputs. */
  readonly commercialUseAllowed: boolean;
}

export interface MixdownOutcome {
  readonly asset: AudioAsset;
  readonly metadata: MixAssetMetadata;
  readonly render: MixdownRenderResult;
  readonly plan: MixdownPlan;
  /** Requirement 28.28: the attenuation is in the response as well as in the metadata. */
  readonly attenuationDb: number;
}

export function createMixdownRenderer(options: MixdownRendererOptions) {
  const { store, render, mixAssets } = options;
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? randomUUID;

  /** Requirement 28.1's ownership check, the same one `timeline-service.ts` applies. */
  async function loadOwned(ownerId: string, projectId: string): Promise<TimelineProject> {
    const record = await store.load(projectId);
    if (record === null) throw timelineProjectNotFound(projectId);
    if (record.project.ownerId !== ownerId) throw timelineProjectForbidden(projectId);
    return record.project;
  }

  /** Requirement 28.18's settings for the tracks that actually have a clip in the mix. */
  function trackRequests(
    project: TimelineProject,
    plan: MixdownPlan,
  ): readonly MixdownTrackRequest[] {
    const tracks = [...new Set(plan.clips.map((clip) => clip.track))].sort((a, b) => a - b);
    return tracks.map((track) => {
      const settings = project.tracks[track];
      return {
        track,
        volumeDb: settings?.volumeDb ?? 0,
        pan: settings?.pan ?? 0,
      };
    });
  }

  function clipRequests(plan: MixdownPlan): readonly MixdownClipRequest[] {
    return plan.clips.map((clip) => ({
      clipId: clip.id,
      assetId: clip.assetId,
      track: clip.track,
      startTimeMs: clip.startTimeMs,
      // Requirement 28.13's derived length, computed once here so the worker's truncation and
      // this service's length arithmetic cannot disagree.
      playLengthMs: clipPlayLengthMs(clip),
      trimStartMs: clip.trimStartMs,
      trimEndMs: clip.trimEndMs,
      gainDb: clip.gainDb,
      fadeInMs: clip.fadeInMs,
      fadeOutMs: clip.fadeOutMs,
    }));
  }

  /**
   * Requirements 28.24–28.27 checked against what came back.
   *
   * Throws rather than returning a verdict, because every branch is a failure of this
   * service's own promise and there is no caller decision to make.
   */
  function verify(
    plan: MixdownPlan,
    params: MixdownRenderParams,
    result: MixdownRenderResult,
  ): void {
    // Requirement 28.27's parameter list: the produced audio must have the requested shape.
    if (result.sampleRate !== params.sampleRate || result.channels !== params.channels) {
      throw mixdownInvariantBreached('shape_changed', {
        requested: { sampleRate: params.sampleRate, channels: params.channels },
        produced: { sampleRate: result.sampleRate, channels: result.channels },
      });
    }

    // Requirement 28.25.
    if (!mixdownLengthWithinTolerance(plan.lengthMs, result.durationMs)) {
      throw mixdownInvariantBreached('length_out_of_tolerance', {
        expectedMs: plan.lengthMs,
        producedMs: result.durationMs,
      });
    }

    // Requirement 28.26: the order the worker summed in must be the planned one. Checked
    // because it is the premise both Property 12 and Property 13 rest on, and a worker that
    // silently reordered would still return plausible audio.
    const planned = plan.clips.map((clip) => clip.id);
    if (
      result.renderedClipIds.length !== planned.length ||
      result.renderedClipIds.some((id, index) => id !== planned[index])
    ) {
      throw mixdownInvariantBreached('summation_order_changed', {
        planned,
        rendered: result.renderedClipIds,
      });
    }

    const expected = peakNormalisation(result.peakBefore);

    if (!params.normalisePeak) {
      // Normalisation was off, so nothing may have been attenuated. The verdict is still
      // computed above, because a caller that disabled it should be able to see from
      // `peakBefore` that the mix clips.
      if (result.normalised || result.attenuationDb !== 0) {
        throw mixdownInvariantBreached('attenuation_reported_without_overshoot', {
          normalisePeak: false,
          attenuationDb: result.attenuationDb,
        });
      }
      return;
    }

    // Requirement 28.24: at or below the ceiling, samples are untouched and the recorded
    // attenuation is 0 dB.
    if (!expected.applied) {
      if (result.attenuationDb !== 0 || result.normalised) {
        throw mixdownInvariantBreached('attenuation_reported_without_overshoot', {
          peakBefore: result.peakBefore,
          attenuationDb: result.attenuationDb,
        });
      }
      return;
    }

    // Requirement 28.28: the peak is brought into [0.99, 1.0] by a single coefficient, and
    // the reported attenuation is the one that coefficient implies.
    if (!normalisedPeakWithinWindow(result.peakAfter)) {
      throw mixdownInvariantBreached('peak_not_normalised', {
        peakBefore: result.peakBefore,
        peakAfter: result.peakAfter,
      });
    }
    // A tenth of a decibel of slack, matching the reporting precision of Requirement 30.24
    // and design §7.1's gain tolerance: the worker computes the coefficient in float64 and
    // measures the peak back off float32 samples, so an exact equality here would fail on
    // rounding rather than on a breach.
    if (Math.abs(result.attenuationDb - expected.attenuationDb) > 0.1) {
      throw mixdownInvariantBreached('peak_not_normalised', {
        reportedAttenuationDb: result.attenuationDb,
        expectedAttenuationDb: expected.attenuationDb,
      });
    }
  }

  return {
    /**
     * Requirements 28.24–28.29: render a project's mixdown and store it as a `mix` asset.
     *
     * Requirement 28.27's reproducibility is a property of this path being a *function* of
     * the project and the parameters: nothing here reads a clock before the render, draws a
     * random number that reaches the audio, or depends on which worker answers.
     * `MIXDOWN_REPRODUCIBILITY_RUNS` renders of an unchanged project therefore agree, which
     * `dsp/test/test_mixdown.py`'s Property 13 asserts at sample level.
     */
    async renderProject(request: RenderMixdownRequest): Promise<MixdownOutcome> {
      const project = await loadOwned(request.ownerId, request.projectId);

      // Requirement 28.29. Nothing has been written, so the project is unchanged.
      const plan = planMixdown(project);
      if (!plan.ok) throw mixdownNoRenderTarget(plan);

      // Requirement 19.11, before the render rather than after it.
      if (plan.lengthMs > ASSET_DURATION_MAX_MS) {
        throw mixdownLengthUnsupported(plan.lengthMs);
      }
      // Requirement 19.6 against Requirement 28.5.
      if (plan.sourceAssetIds.length > MAX_PARENTS_PER_ASSET) {
        throw mixdownInputLimitExceeded(plan.sourceAssetIds);
      }

      const params: MixdownRenderParams = { ...DEFAULT_MIXDOWN_PARAMS, ...request.params };

      const result = await render.render({
        projectId: project.id,
        clips: clipRequests(plan),
        tracks: trackRequests(project, plan),
        params,
        expectedLengthMs: plan.lengthMs,
      });

      verify(plan, params, result);

      const metadata: MixAssetMetadata = {
        projectId: project.id,
        // Requirement 28.28's 감쇠량, and Requirement 28.24's 0 dB for an untouched mix.
        attenuationDb: result.attenuationDb,
        peakBefore: result.peakBefore,
        peakAfter: result.peakAfter,
        sampleRate: result.sampleRate,
        channels: result.channels,
        peakNormalisationEnabled: params.normalisePeak,
        requestedLengthMs: plan.lengthMs,
        durationMs: result.durationMs,
        renderedClipIds: result.renderedClipIds,
        soloActive: plan.soloActive,
      };

      const asset: AudioAsset = {
        id: generateId(),
        ownerId: request.ownerId,
        name: request.assetName ?? project.name,
        assetKind: 'mix',
        // Requirement 19.3 stores an integer millisecond length. Rounded here rather than in
        // the worker, for the reason `pipeline.py` gives: the ±10 ms check of Requirement
        // 28.25 is made on the unrounded value first.
        durationMs: Math.round(result.durationMs),
        sampleRate: result.sampleRate,
        channels: result.channels,
        engineId: MIXDOWN_RENDERER_ENGINE_ID,
        // Requirement 19.3: no engine, so no seed.
        seed: -1,
        // Requirement 19.10: the loop flag applies to `bgm` and `sfx` only.
        isLoop: false,
        commercialUseAllowed: request.commercialUseAllowed,
        provenance: request.provenance,
        createdAtMs: clock.now().getTime(),
        isDeleted: false,
      };

      const violations = validateAudioAsset(asset);
      if (violations.length > 0) throw mixdownAssetInvalid(violations);

      await mixAssets.save({
        asset,
        // Requirements 19.6, 19.7: the mix's direct inputs, derivation type `mixdown`.
        sourceAssetIds: plan.sourceAssetIds,
        metadata,
        objectKey: result.objectKey,
      });

      return { asset, metadata, render: result, plan, attenuationDb: result.attenuationDb };
    },

    /** Requirements 28.19, 28.20, 28.25, 28.26, 28.29 without rendering anything. */
    async planProject(ownerId: string, projectId: string) {
      return planMixdown(await loadOwned(ownerId, projectId));
    },

    /** Requirement 28.27's 3, exposed so a caller can state what it is verifying. */
    reproducibilityRuns: MIXDOWN_REPRODUCIBILITY_RUNS,
  };
}

export type MixdownRenderer = ReturnType<typeof createMixdownRenderer>;
