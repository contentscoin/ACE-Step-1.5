import { describe, expect, it } from 'vitest';

import { watermarkId } from '../../domain/disclosure/ai-disclosure';
import type { AssetProvenance } from '../../domain/provenance';
import { createHistory } from '../../domain/timeline/history';
import { executeCommand, planAddClip } from '../../domain/timeline/commands';
import type { TimelineProject } from '../../domain/timeline/project';
import { createDownloadService } from '../../services/library/download-service';
import { createLibraryService } from '../../services/library/library-service';
import type { DownloadPayload } from '../../services/library/ports';
import { createMixdownRenderer } from '../../services/timeline/mixdown-renderer';
import type {
  MixdownAssetWriteRequest,
  MixdownRenderRequest,
} from '../../services/timeline/mixdown-ports';
import type { TimelineProjectRecord } from '../../services/timeline/ports';
import {
  assetRecord,
  inMemoryAssetStore,
  inMemoryPlaylistStore,
} from '../support/library-harness';
import { createMutableClock } from '../support/mutable-clock';
import { projectWith } from '../support/timeline-harness';

/**
 * 타임라인 플로 — 프로젝트 생성 → 클립 배치 → 믹스다운 → 다운로드.
 *
 * **Validates: Requirements 28.1, 28.6, 28.24, 13.1**
 *
 * A service composition rather than HTTP: Requirement 28 has no routes yet (task 9.1 mounted
 * Requirement 17's), and `test/e2e/README.md` says which of the seven are which. What runs is the
 * real `applyEdit`, the real `Mixdown_Renderer` and the real `Library_Service` download path,
 * joined the way the product joins them — the mix asset the renderer writes is the asset the
 * download reads.
 *
 * That join is the claim. Requirement 28.24 says a mixdown produces a `mix` Audio_Asset and 13.1
 * says an Audio_Asset can be downloaded; a product can satisfy both and still write a mix nobody
 * can fetch, because the identifier the renderer returns is not the identifier the library knows.
 */

const OWNER = 'owner-0'; // 's owner — the renderer's ownership gate is real.

const PROVENANCE: AssetProvenance = {
  engineId: 'musicstudio-mixdown',
  weightLicenseId: 'apache-2.0',
  attributionText: 'MusicStudio',
  commercialUseAllowed: true,
  nonCommercialLicenseListVersion: 1,
  recordedAtMs: 1_700_000_000_000,
  aiGenerated: true,
  watermarkId: watermarkId(1),
};

function record(project: TimelineProject): TimelineProjectRecord {
  return { project, history: createHistory(), createdAtMs: 0, updatedAtMs: 0 };
}

/** The renderer, with the two things outside the product faked and nothing else. */
function studio(project: TimelineProject) {
  const renders: MixdownRenderRequest[] = [];
  const writes: MixdownAssetWriteRequest[] = [];
  let stored = record(project);
  let mixAssetId = '';

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
        renders.push(request);
        return {
          objectKey: 'mix/night-drive',
          sampleRate: 48_000,
          channels: 2,
          frameCount: 96_000,
          durationMs: 2_000,
          attenuationDb: 0,
          peakBefore: 0.5,
        };
      },
    },
    audio: { objectKeyFor: async (assetId) => `audio/${assetId}` },
    assets: {
      save: async (request) => {
        writes.push(request);
        mixAssetId = 'asset-mix-1';
        return mixAssetId;
      },
    },
    credits: {
      chargeMixdown: async (request) => ({
        amount: 2 + Math.ceil(request.renderDurationMs / 1_000),
        balanceAfter: 90,
      }),
    },
  });

  return { renderer, renders, writes, mixAssetId: () => mixAssetId, current: () => stored };
}

/** The library the mix lands in, and the download path over it. */
function libraryFor(assetId: string, objectKey: string) {
  const converted: { objectKey: string; format: string }[] = [];
  const assets = inMemoryAssetStore([
    assetRecord({ id: assetId, ownerId: OWNER, name: 'Night Drive Mix', assetKind: 'mix', objectKey }),
  ]);
  const library = createLibraryService({
    assets,
    playlists: inMemoryPlaylistStore(),
    clock: createMutableClock(),
    generateId: () => 'playlist-1',
  });

  const download = createDownloadService({
    assets,
    loadOwned: library.loadOwned,
    plans: { planIdFor: async () => 'studio' },
    conversion: {
      convert: async (request): Promise<DownloadPayload> => {
        converted.push({ objectKey: request.objectKey, format: request.format });
        return {
          bytes: new Uint8Array([1, 2, 3]),
          format: request.format,
          sampleRate: 48_000,
          tags: request.tags,
        };
      },
    },
    archive: { archive: async () => new Uint8Array([9]) },
  });

  return { library, download, converted };
}

describe('프로젝트 → 클립 배치 → 믹스다운 → 다운로드', () => {
  it('downloads the mix the renderer wrote, from the asset it wrote it as', async () => {
    // Requirement 28.1 — a project, and 28.6 — a clip placed on it, through the real edit
    // function rather than by constructing the end state.
    const empty = projectWith([]);
    const plan = planAddClip(empty, {
      clipId: 'a',
      assetId: 'asset-source-1',
      sourceDurationMs: 2_000,
      track: 0,
      startTimeMs: 0,
    });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    if (!plan.ok) return;

    const project = executeCommand(empty, plan.command);
    expect(project.clips).toHaveLength(1);

    // Requirement 28.24 — the mixdown, which stores a `mix` Audio_Asset.
    const { renderer, renders, writes, mixAssetId } = studio(project);
    const response = await renderer.renderProject({
      ownerId: OWNER,
      projectId: project.id,
      jobId: 'job-mix-1',
      provenance: PROVENANCE,
    });

    expect(renders).toHaveLength(1);
    expect(renders[0]?.clips).toHaveLength(1);
    // The write names the clip's asset as a lineage parent (Requirement 19.7), which is how
    // the mix stays attached to what it was made from.
    expect(writes[0]?.sourceAssetIds).toEqual(['asset-source-1']);
    expect(response.assetId).toBe(mixAssetId());

    // Requirement 13.1 — and that asset downloads. Keyed on what the renderer actually
    // returned, so an identifier that did not survive the hand-off fails here.
    const { download, converted } = libraryFor(response.assetId, writes[0]?.objectKey ?? '');
    const file = await download.download(OWNER, response.assetId, 'wav');

    expect(file.format).toBe('wav');
    expect(file.sampleRate).toBe(48_000);
    expect(file.fileName).toContain(response.assetId);
    // Converted from the object the renderer wrote, not from some other object.
    expect(converted).toEqual([{ objectKey: 'mix/night-drive', format: 'wav' }]);
  });

  it('refuses to render a project with nothing to render, and writes no asset', async () => {
    // Requirement 28.29. The failure has to happen before anything is stored, or the library
    // ends up holding a `mix` asset for a mixdown that never happened.
    const { renderer, writes } = studio(projectWith([]));

    await expect(
      renderer.renderProject({
        ownerId: OWNER,
        projectId: projectWith([]).id,
        jobId: 'job-mix-2',
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow();

    expect(writes).toEqual([]);
  });
});
