import { beforeEach, describe, expect, it } from 'vitest';

import { MIXDOWN_ENGINE_ID } from '../../../services/timeline/mixdown-ports';
import type {
  MixdownAssetWriteRequest,
  MixdownRenderRequest,
  MixdownRenderResult,
} from '../../../services/timeline/mixdown-ports';
import { createMixdownRenderer } from '../../../services/timeline/mixdown-renderer';
import type { TimelineProjectRecord } from '../../../services/timeline/ports';
import type { TimelineProject } from '../../../domain/timeline/project';
import { createHistory } from '../../../domain/timeline/history';
import type { AssetProvenance } from '../../../domain/provenance';
import { clip, projectWith } from '../../support/timeline-harness';

/**
 * Requirements 28.24, 28.25, 28.28, 28.29 at the service seam.
 *
 * Everything the renderer talks to is a fake declared here, for the reason
 * `services/timeline/mixdown-ports.ts` gives: no broker and no object store exist in this
 * environment, and none of these rules is about either.
 */

const PROVENANCE: AssetProvenance = {
  engineId: 'ace-step-1.5',
  weightLicenseId: 'apache-2.0',
  attributionText: 'ACE-Step',
  commercialUseAllowed: true,
  nonCommercialLicenseListVersion: 1,
  recordedAtMs: 1_700_000_000_000,
  aiGenerated: true,
};

function projectRecord(project: TimelineProject): TimelineProjectRecord {
  return { project, history: createHistory(), createdAtMs: 0, updatedAtMs: 0 };
}

function harness(project: TimelineProject, result?: Partial<MixdownRenderResult>) {
  const requests: MixdownRenderRequest[] = [];
  const writes: MixdownAssetWriteRequest[] = [];
  let stored = projectRecord(project);

  const renderer = createMixdownRenderer({
    store: {
      insert: async () => undefined,
      load: async (id) => (id === project.id ? stored : null),
      update: async (next) => {
        stored = next;
      },
      remove: async () => undefined,
      listByOwner: async () => [stored],
    },
    render: {
      render: async (request) => {
        requests.push(request);
        return {
          objectKey: 'mix/object',
          sampleRate: 48_000,
          channels: 2,
          frameCount: 48_000,
          durationMs: 1_000,
          attenuationDb: 0,
          peakBefore: 0.5,
          ...result,
        };
      },
    },
    audio: { objectKeyFor: async (assetId) => `audio/${assetId}` },
    assets: {
      save: async (request) => {
        writes.push(request);
        return 'mix-asset-1';
      },
    },
  });

  return { renderer, requests, writes, current: () => stored };
}

const ONE_SECOND = clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 });

describe('Mixdown_Renderer (Requirements 28.24-28.29)', () => {
  let project: TimelineProject;

  beforeEach(() => {
    project = projectWith([ONE_SECOND]);
  });

  it('renders the target clips and stores a mix asset (28.24)', async () => {
    const { renderer, requests, writes } = harness(project);

    const response = await renderer.renderProject({
      ownerId: project.ownerId,
      projectId: project.id,
      provenance: PROVENANCE,
    });

    expect(response.assetId).toBe('mix-asset-1');
    expect(response.renderedClipIds).toEqual(['a']);
    expect(requests[0]?.clips.map((entry) => entry.clipId)).toEqual(['a']);
    expect(writes[0]?.objectKey).toBe('mix/object');
    // Design §3.6: a mix is produced internally, so no generation engine is credited.
    expect(writes[0]?.provenance.engineId).toBe(MIXDOWN_ENGINE_ID);
  });

  it('records the attenuation on the asset as well as in the response (28.28)', async () => {
    const { renderer, writes } = harness(project, { attenuationDb: 6.5, peakBefore: 2.1 });

    const response = await renderer.renderProject({
      ownerId: project.ownerId,
      projectId: project.id,
      provenance: PROVENANCE,
    });

    expect(response.attenuationDb).toBe(6.5);
    expect(writes[0]?.attenuationDb).toBe(6.5);
  });

  it('reports zero attenuation when the sum already fit (28.24)', async () => {
    const { renderer, writes } = harness(project);
    const response = await renderer.renderProject({
      ownerId: project.ownerId,
      projectId: project.id,
      provenance: PROVENANCE,
    });

    expect(response.attenuationDb).toBe(0);
    expect(writes[0]?.attenuationDb).toBe(0);
  });

  it('refuses a project with no render target and leaves it untouched (28.29)', async () => {
    const muted = projectWith([clip({ id: 'a', track: 0, muted: true })]);
    const { renderer, requests, writes, current } = harness(muted);
    const before = current();

    await expect(
      renderer.renderProject({
        ownerId: muted.ownerId,
        projectId: muted.id,
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'mixdown_no_render_target', statusCode: 409 });

    // "Timeline_Project 상태를 변경하지 않는다", and nothing downstream was reached.
    expect(current()).toBe(before);
    expect(requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('names the excluded clips in the refusal (28.29)', async () => {
    const muted = projectWith([clip({ id: 'a', track: 0, muted: true })]);
    const { renderer } = harness(muted);

    await expect(
      renderer.renderProject({
        ownerId: muted.ownerId,
        projectId: muted.id,
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({
      details: { excluded: [{ clipId: 'a', reason: 'clip_muted' }] },
    });
  });

  it('sends only the tracks that carry a clip', async () => {
    const twoTracks = projectWith([
      clip({ id: 'a', track: 0, sourceDurationMs: 1_000 }),
      clip({ id: 'b', track: 3, sourceDurationMs: 1_000 }),
    ]);
    const { renderer, requests } = harness(twoTracks);

    await renderer.renderProject({
      ownerId: twoTracks.ownerId,
      projectId: twoTracks.id,
      provenance: PROVENANCE,
    });

    expect(requests[0]?.tracks.map((entry) => entry.track)).toEqual([0, 3]);
  });

  it('refuses a length the worker returned outside 28.25 s tolerance', async () => {
    const { renderer, writes } = harness(project, { durationMs: 1_500 });

    await expect(
      renderer.renderProject({
        ownerId: project.ownerId,
        projectId: project.id,
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'mixdown_render_invalid', statusCode: 502 });
    expect(writes).toHaveLength(0);
  });

  it('accepts a length inside the tolerance', async () => {
    const { renderer } = harness(project, { durationMs: 1_008 });
    await expect(
      renderer.renderProject({
        ownerId: project.ownerId,
        projectId: project.id,
        provenance: PROVENANCE,
      }),
    ).resolves.toMatchObject({ durationMs: 1_008 });
  });

  it('refuses an attenuation outside 28.28 s band', async () => {
    const { renderer, writes } = harness(project, { attenuationDb: 44 });

    await expect(
      renderer.renderProject({
        ownerId: project.ownerId,
        projectId: project.id,
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'mixdown_render_invalid' });
    expect(writes).toHaveLength(0);
  });

  it('refuses a clip whose asset has no stored audio', async () => {
    const { renderer } = harness(project);
    const rendererWithoutAudio = createMixdownRenderer({
      store: {
        insert: async () => undefined,
        load: async () => projectRecord(project),
        update: async () => undefined,
        remove: async () => undefined,
        listByOwner: async () => [],
      },
      render: { render: async () => ({}) as MixdownRenderResult },
      audio: { objectKeyFor: async () => null },
      assets: { save: async () => 'unused' },
    });
    expect(renderer).toBeDefined();

    await expect(
      rendererWithoutAudio.renderProject({
        ownerId: project.ownerId,
        projectId: project.id,
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'mixdown_audio_unavailable' });
  });

  it('answers 404 for an unknown project and 403 for another account s', async () => {
    const { renderer } = harness(project);

    await expect(
      renderer.renderProject({
        ownerId: project.ownerId,
        projectId: 'missing',
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      renderer.renderProject({
        ownerId: 'someone-else',
        projectId: project.id,
        provenance: PROVENANCE,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
