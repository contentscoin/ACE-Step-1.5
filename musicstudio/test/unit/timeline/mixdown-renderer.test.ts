import { describe, expect, it } from 'vitest';

import { ASSET_DURATION_MAX_MS } from '../../../domain/audio-asset';
import { MAX_PARENTS_PER_ASSET } from '../../../domain/lineage/limits';
import { isGenerationError } from '../../../services/generation/errors';
import {
  DEFAULT_MIXDOWN_PARAMS,
  MIXDOWN_RENDERER_ENGINE_ID,
  createMixdownRenderer,
} from '../../../services/timeline/mixdown-renderer';
import type { MixdownRenderResult } from '../../../services/timeline/mixdown-ports';
import { createMutableClock } from '../../support/mutable-clock';
import {
  clip,
  inMemoryTimelineStore,
  mixProvenance,
  projectWith,
  recordOf,
  recordingMixAssetStore,
  stubMixdownRenderPort,
} from '../../support/timeline-harness';
import type { TimelineClip, TimelineProject } from '../../../domain/timeline/project';

/**
 * `Mixdown_Renderer` — the product-layer half of Requirements 28.24–28.29.
 *
 * **Validates: Requirements 28.24, 28.25, 28.26, 28.28, 28.29**
 *
 * The port is a stub, deliberately: no broker is reachable, and the samples are the DSP
 * worker's. Requirement 28.26's commutativity and 28.27's reproducibility are asserted over
 * real audio in `dsp/test/test_mixdown.py` as design §10's Properties 12 and 13. What this
 * suite establishes is what cannot be tested from Python — that an empty render is refused
 * *before* the port is reached and without touching the project (28.29), that the clips arrive
 * in summation order (28.26), that a breached invariant is reported rather than stored, and
 * that the attenuation lands in both the response and the `mix` asset's metadata (28.28).
 */

const OWNER = 'owner-0';
const PROJECT = 'project-0';

function renderer(
  project: TimelineProject | null,
  overrides: Partial<MixdownRenderResult> = {},
) {
  const store = inMemoryTimelineStore();
  if (project !== null) void store.insert(recordOf(project));
  const render = stubMixdownRenderPort(overrides);
  const mixAssets = recordingMixAssetStore();
  const clock = createMutableClock(new Date(5_000));
  let counter = 0;

  return {
    store,
    render,
    mixAssets,
    service: createMixdownRenderer({
      store,
      render: render.port,
      mixAssets,
      clock,
      generateId: () => `mix-${String(++counter)}`,
    }),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER,
    projectId: PROJECT,
    provenance: mixProvenance(),
    commercialUseAllowed: true,
    ...overrides,
  } as Parameters<ReturnType<typeof renderer>['service']['renderProject']>[0];
}

const TWO_CLIPS: readonly TimelineClip[] = [
  clip({ id: 'clip-b', assetId: 'asset-2', track: 1, startTimeMs: 2_000, sourceDurationMs: 1_000 }),
  clip({ id: 'clip-a', assetId: 'asset-1', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
];

describe('renderProject (Requirement 28.24)', () => {
  it('stores the result as a mix Audio_Asset', async () => {
    const { service, mixAssets } = renderer(projectWith(TWO_CLIPS));

    const outcome = await service.renderProject(request());

    expect(outcome.asset.assetKind).toBe('mix');
    expect(outcome.asset.ownerId).toBe(OWNER);
    expect(outcome.asset.sampleRate).toBe(DEFAULT_MIXDOWN_PARAMS.sampleRate);
    expect(outcome.asset.channels).toBe(DEFAULT_MIXDOWN_PARAMS.channels);
    // Requirement 19.12's marker slot: no generation engine touched this audio.
    expect(outcome.asset.engineId).toBe(MIXDOWN_RENDERER_ENGINE_ID);
    // Requirement 19.3: no engine, so no seed. Requirement 19.10: not loopable.
    expect(outcome.asset.seed).toBe(-1);
    expect(outcome.asset.isLoop).toBe(false);
    expect(mixAssets.saved).toHaveLength(1);
    expect(mixAssets.saved[0]?.asset.id).toBe(outcome.asset.id);
  });

  it('records the mix lineage back to the clips source assets', async () => {
    const { service, mixAssets } = renderer(projectWith(TWO_CLIPS));

    await service.renderProject(request());

    // Requirement 19.7: a `mix` never exists without inputs. In summation order, de-duplicated.
    expect(mixAssets.saved[0]?.sourceAssetIds).toEqual(['asset-1', 'asset-2']);
  });

  it('names the asset after the project unless told otherwise', async () => {
    const { service } = renderer({ ...projectWith(TWO_CLIPS), name: 'Scene 4' });
    expect((await service.renderProject(request())).asset.name).toBe('Scene 4');

    const other = renderer({ ...projectWith(TWO_CLIPS), name: 'Scene 4' });
    expect(
      (await other.service.renderProject(request({ assetName: 'Trailer mix' }))).asset.name,
    ).toBe('Trailer mix');
  });

  it('sends the clips in summation order, not project order (Requirement 28.26)', async () => {
    const { service, render } = renderer(projectWith(TWO_CLIPS));

    await service.renderProject(request());

    // The project lists clip-b first; the render must receive clip-a first.
    expect(render.requests[0]?.clips.map((c) => c.clipId)).toEqual(['clip-a', 'clip-b']);
  });

  it('sends each clips derived play length rather than its source duration', async () => {
    const trimmed = clip({
      id: 'clip-a',
      startTimeMs: 0,
      sourceDurationMs: 10_000,
      trimStartMs: 1_000,
      trimEndMs: 2_000,
    });
    const { service, render } = renderer(projectWith([trimmed]));

    await service.renderProject(request());

    // Requirement 28.13.
    expect(render.requests[0]?.clips[0]?.playLengthMs).toBe(7_000);
    expect(render.requests[0]?.expectedLengthMs).toBe(7_000);
  });

  it('sends track volume and pan only for the tracks in the mix', async () => {
    const project = projectWith(TWO_CLIPS);
    const withSettings: TimelineProject = {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 1 ? { ...track, volumeDb: -6, pan: 0.5 } : track,
      ),
    };
    const { service, render } = renderer(withSettings);

    await service.renderProject(request());

    expect(render.requests[0]?.tracks).toEqual([
      { track: 0, volumeDb: 0, pan: 0 },
      { track: 1, volumeDb: -6, pan: 0.5 },
    ]);
  });

  it('records the render parameters Requirement 28.27 enumerates', async () => {
    const { service } = renderer(projectWith(TWO_CLIPS));

    const outcome = await service.renderProject(
      request({ params: { channels: 1, normalisePeak: false } }),
    );

    expect(outcome.metadata.channels).toBe(1);
    expect(outcome.metadata.peakNormalisationEnabled).toBe(false);
    expect(outcome.metadata.sampleRate).toBe(48_000);
    expect(outcome.metadata.renderedClipIds).toEqual(['clip-a', 'clip-b']);
  });
});

describe('the empty render target set (Requirement 28.29)', () => {
  it('refuses a project with no clips and leaves it untouched', async () => {
    const { service, store, render, mixAssets } = renderer(projectWith([]));
    const before = await store.load(PROJECT);

    await expect(service.renderProject(request())).rejects.toMatchObject({
      code: 'mixdown_no_render_target',
      statusCode: 409,
    });

    // "Timeline_Project 상태를 변경하지 않는다" — structurally: nothing was written, and the
    // port was never even reached, so no credit could have been spent either.
    expect(await store.load(PROJECT)).toEqual(before);
    expect(render.requests).toHaveLength(0);
    expect(mixAssets.saved).toHaveLength(0);
  });

  it('refuses a project whose clips are all excluded, saying why', async () => {
    const project = projectWith([
      clip({ id: 'clip-a', track: 0, startTimeMs: 0, muted: true }),
      clip({ id: 'clip-b', track: 1, startTimeMs: 0, muted: true }),
    ]);
    const { service, render } = renderer(project);

    const error = await service.renderProject(request()).catch((thrown: unknown) => thrown);

    expect(isGenerationError(error)).toBe(true);
    if (isGenerationError(error)) {
      expect(error.code).toBe('mixdown_no_render_target');
      // Requirement 28.29's 사유 코드, plus which clips and why — a user can act on it.
      expect(error.details).toMatchObject({ reason: 'all_clips_excluded' });
      expect(error.details.excluded).toHaveLength(2);
    }
    expect(render.requests).toHaveLength(0);
  });
});

describe('refusals that precede the render', () => {
  it('refuses a mix longer than an Audio_Asset may be (Requirement 19.11)', async () => {
    const long = clip({
      id: 'clip-a',
      track: 0,
      startTimeMs: ASSET_DURATION_MAX_MS,
      sourceDurationMs: 1_000,
    });
    const { service, render } = renderer(projectWith([long]));

    await expect(service.renderProject(request())).rejects.toMatchObject({
      code: 'mixdown_length_unsupported',
      statusCode: 409,
    });
    // Checked before the render, so an hour of audio is not produced and thrown away.
    expect(render.requests).toHaveLength(0);
  });

  it('refuses a mix with more input assets than Requirement 19.6 permits', async () => {
    const clips = Array.from({ length: MAX_PARENTS_PER_ASSET + 1 }, (_, index) =>
      clip({
        id: `clip-${String(index).padStart(3, '0')}`,
        assetId: `asset-${String(index)}`,
        // One per track would exceed 32 tracks, so they are laid out along track 0 without
        // overlapping — Requirement 28.7.
        track: 0,
        startTimeMs: index * 2_000,
        sourceDurationMs: 1_000,
      }),
    );
    const { service, render } = renderer(projectWith(clips));

    await expect(service.renderProject(request())).rejects.toMatchObject({
      code: 'mixdown_input_limit_exceeded',
      statusCode: 409,
    });
    expect(render.requests).toHaveLength(0);
  });

  it('reports an unknown project as missing and someone elses as forbidden', async () => {
    const { service } = renderer(null);
    await expect(service.renderProject(request())).rejects.toMatchObject({
      code: 'timeline_project_not_found',
    });

    const owned = renderer(projectWith(TWO_CLIPS));
    await expect(
      owned.service.renderProject(request({ ownerId: 'someone-else' })),
    ).rejects.toMatchObject({ code: 'timeline_project_forbidden', statusCode: 403 });
  });
});

describe('the renderer checks its own invariants (Requirements 28.24–28.27)', () => {
  it('rejects a length outside Requirement 28.25s tolerance', async () => {
    const { service, mixAssets } = renderer(projectWith(TWO_CLIPS), { durationMs: 3_011 });

    const error = await service.renderProject(request()).catch((thrown: unknown) => thrown);

    expect(isGenerationError(error)).toBe(true);
    if (isGenerationError(error)) {
      expect(error.code).toBe('mixdown_render_invariant_breached');
      expect(error.statusCode).toBe(500);
      expect(error.details).toMatchObject({ breach: 'length_out_of_tolerance' });
    }
    // Not stored: a mix whose length nobody checked is worse than a reported failure.
    expect(mixAssets.saved).toHaveLength(0);
  });

  it('accepts a length inside the tolerance', async () => {
    const { service } = renderer(projectWith(TWO_CLIPS), { durationMs: 3_009 });
    await expect(service.renderProject(request())).resolves.toBeDefined();
  });

  it('rejects a summation order other than the planned one', async () => {
    const { service } = renderer(projectWith(TWO_CLIPS), {
      renderedClipIds: ['clip-b', 'clip-a'],
    });

    await expect(service.renderProject(request())).rejects.toMatchObject({
      code: 'mixdown_render_invariant_breached',
      details: { breach: 'summation_order_changed' },
    });
  });

  it('rejects a shape other than the requested one', async () => {
    const { service } = renderer(projectWith(TWO_CLIPS), { channels: 1 });
    await expect(service.renderProject(request())).rejects.toMatchObject({
      details: { breach: 'shape_changed' },
    });
  });

  it('rejects an attenuation reported for a mix that did not overshoot', async () => {
    // Requirement 28.24: at or below 1.0 the samples are unchanged and 0 dB is recorded.
    const { service } = renderer(projectWith(TWO_CLIPS), {
      peakBefore: 0.4,
      peakAfter: 0.4,
      attenuationDb: 3,
      normalised: true,
    });
    await expect(service.renderProject(request())).rejects.toMatchObject({
      details: { breach: 'attenuation_reported_without_overshoot' },
    });
  });

  it('rejects an overshoot the worker did not bring into the window', async () => {
    const { service } = renderer(projectWith(TWO_CLIPS), {
      peakBefore: 2,
      peakAfter: 1.8,
      attenuationDb: 6.06,
      normalised: true,
    });
    await expect(service.renderProject(request())).rejects.toMatchObject({
      details: { breach: 'peak_not_normalised' },
    });
  });

  it('rejects an attenuation that disagrees with the coefficient the peak implies', async () => {
    const { service } = renderer(projectWith(TWO_CLIPS), {
      peakBefore: 2,
      peakAfter: 0.995,
      // The peak implies ~6.06 dB; a wildly different figure would be stored on the asset.
      attenuationDb: 20,
      normalised: true,
    });
    await expect(service.renderProject(request())).rejects.toMatchObject({
      details: { breach: 'peak_not_normalised' },
    });
  });
});

describe('the attenuation is reported and stored (Requirement 28.28)', () => {
  it('puts the attenuation in the response and in the asset metadata', async () => {
    const { service, mixAssets } = renderer(projectWith(TWO_CLIPS), {
      peakBefore: 2,
      peakAfter: 0.995,
      attenuationDb: 6.0554,
      normalised: true,
    });

    const outcome = await service.renderProject(request());

    // "응답과 `mix` Audio_Asset 메타데이터에 포함한다" — both, and the same number.
    expect(outcome.attenuationDb).toBeCloseTo(6.0554, 4);
    expect(outcome.metadata.attenuationDb).toBe(outcome.attenuationDb);
    expect(mixAssets.saved[0]?.metadata.attenuationDb).toBe(outcome.attenuationDb);
    expect(mixAssets.saved[0]?.metadata.peakBefore).toBe(2);
  });

  it('records 0 dB for a mix that needed no attenuation (Requirement 28.24)', async () => {
    const { service, mixAssets } = renderer(projectWith(TWO_CLIPS));

    const outcome = await service.renderProject(request());

    expect(outcome.attenuationDb).toBe(0);
    expect(mixAssets.saved[0]?.metadata.attenuationDb).toBe(0);
  });

  it('records whether solo narrowed the render', async () => {
    const project = projectWith(TWO_CLIPS);
    const soloed: TimelineProject = {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 0 ? { ...track, solo: true } : track,
      ),
    };
    const { service } = renderer(soloed);

    const outcome = await service.renderProject(request());

    expect(outcome.metadata.soloActive).toBe(true);
    expect(outcome.metadata.renderedClipIds).toEqual(['clip-a']);
  });
});

describe('planProject', () => {
  it('answers Requirements 28.19, 28.20, 28.25 and 28.26 without rendering', async () => {
    const { service, render } = renderer(projectWith(TWO_CLIPS));

    const plan = await service.planProject(OWNER, PROJECT);

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.clips.map((c) => c.id)).toEqual(['clip-a', 'clip-b']);
      expect(plan.lengthMs).toBe(3_000);
    }
    expect(render.requests).toHaveLength(0);
  });

  it('exposes Requirement 28.27s run count', () => {
    const { service } = renderer(projectWith(TWO_CLIPS));
    expect(service.reproducibilityRuns).toBe(3);
  });
});
