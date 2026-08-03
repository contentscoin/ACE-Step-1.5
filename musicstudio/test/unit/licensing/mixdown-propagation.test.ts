import { describe, expect, it } from 'vitest';

import { createHistory } from '../../../domain/timeline/history';
import { createMixdownRenderer } from '../../../services/timeline/mixdown-renderer';
import type {
  MixdownAssetWriteRequest,
  MixdownCommercialUsePort,
} from '../../../services/timeline/mixdown-ports';
import type { TimelineProjectRecord } from '../../../services/timeline/ports';
import type { TimelineProject } from '../../../domain/timeline/project';
import { clip, projectWith } from '../../support/timeline-harness';
import { provenance } from '../../support/licensing-harness';

/**
 * Requirement 33.12 — a mix inherits the least permissive of its parts.
 *
 * **Validates: Requirement 33.12**
 *
 * > IF Timeline_Project의 Timeline_Clip이 참조하는 Audio_Asset 또는 그 계보 깊이 32 이하의 조상
 * > 자산 중 1개 이상의 상업적 사용 허용 여부가 거짓이면, THEN THE Mixdown_Renderer SHALL 산출된
 * > `mix` Audio_Asset의 상업적 사용 허용 여부를 거짓으로 기록한다
 *
 * The ancestors are already folded into each participant's **stored** flag by
 * `domain/commercial-use.ts` (Requirement 33.21), so the renderer reads that rather than walking
 * lineage a second time. What is checked here is the renderer's own half: that it asks, that one
 * false participant is enough, and that a participant it cannot get an answer for does not
 * default to permitted.
 */

function record(project: TimelineProject): TimelineProjectRecord {
  return { project, history: createHistory(), createdAtMs: 0, updatedAtMs: 0 };
}

function harness(project: TimelineProject, commercialUse?: MixdownCommercialUsePort) {
  const writes: MixdownAssetWriteRequest[] = [];
  const stored = record(project);

  const renderer = createMixdownRenderer({
    store: {
      insert: async () => undefined,
      load: async (id) => (id === project.id ? stored : null),
      update: async () => undefined,
      remove: async () => undefined,
      listByOwner: async () => [stored],
    },
    render: {
      render: async () => ({
        objectKey: 'mix/object',
        sampleRate: 48_000,
        channels: 2,
        frameCount: 48_000,
        durationMs: 1_000,
        attenuationDb: 0,
        peakBefore: 0.5,
      }),
    },
    audio: { objectKeyFor: async (assetId) => `audio/${assetId}` },
    assets: {
      save: async (request) => {
        writes.push(request);
        return 'mix-asset-1';
      },
    },
    credits: {
      chargeMixdown: async () => ({ amount: 3, balanceAfter: 97 }),
    },
    ...(commercialUse === undefined ? {} : { commercialUse }),
  });

  return { renderer, writes };
}

function flags(entries: Readonly<Record<string, boolean>>): MixdownCommercialUsePort {
  return {
    async commercialUseAllowedFor(assetIds) {
      const found = new Map<string, boolean>();
      for (const assetId of assetIds) {
        const value = entries[assetId];
        if (value !== undefined) found.set(assetId, value);
      }
      return found;
    },
  };
}

const TWO_CLIPS = projectWith([
  clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000, assetId: 'asset-ok' }),
  clip({ id: 'b', track: 1, startTimeMs: 0, sourceDurationMs: 1_000, assetId: 'asset-nc' }),
]);

const ONE_CLIP = projectWith([
  clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000, assetId: 'asset-ok' }),
]);

async function render(project: TimelineProject, port?: MixdownCommercialUsePort) {
  const { renderer, writes } = harness(project, port);
  await renderer.renderProject({
    ownerId: project.ownerId,
    projectId: project.id,
    jobId: 'job-1',
    provenance: provenance({ commercialUseAllowed: true }),
  });
  return writes[0];
}

describe('Requirement 33.12 — mixdown commercial-use propagation', () => {
  it('is permitted when every participant is', async () => {
    const write = await render(TWO_CLIPS, flags({ 'asset-ok': true, 'asset-nc': true }));
    expect(write?.provenance.commercialUseAllowed).toBe(true);
  });

  it('is not permitted when one participant is not', async () => {
    // One clause, one clip: the whole mix loses commercial use.
    const write = await render(TWO_CLIPS, flags({ 'asset-ok': true, 'asset-nc': false }));
    expect(write?.provenance.commercialUseAllowed).toBe(false);
  });

  it('treats a participant with no answer as not permitted', async () => {
    // An unknown provenance can never widen permission — the same rule
    // `propagateCommercialUse` applies to an asset missing from its input map. Defaulting the
    // other way would make a store hiccup silently grant commercial rights.
    const write = await render(TWO_CLIPS, flags({ 'asset-ok': true }));
    expect(write?.provenance.commercialUseAllowed).toBe(false);
  });

  it('never widens what the request already said was not permitted', async () => {
    const { renderer, writes } = harness(ONE_CLIP, flags({ 'asset-ok': true }));
    await renderer.renderProject({
      ownerId: ONE_CLIP.ownerId,
      projectId: ONE_CLIP.id,
      jobId: 'job-1',
      provenance: provenance({ commercialUseAllowed: false }),
    });
    expect(writes[0]?.provenance.commercialUseAllowed).toBe(false);
  });

  it('leaves the request’s value alone when the port is not wired', async () => {
    // The conservative reading of an unwired renderer: it cannot narrow, but it also cannot
    // widen. A default of `true` here would be a silent grant on every deployment that forgot.
    const write = await render(ONE_CLIP);
    expect(write?.provenance.commercialUseAllowed).toBe(true);
  });

  it('asks about each participating asset exactly once', async () => {
    const asked: string[][] = [];
    const port: MixdownCommercialUsePort = {
      async commercialUseAllowedFor(assetIds) {
        asked.push([...assetIds]);
        return new Map(assetIds.map((id) => [id, true]));
      },
    };
    const duplicated = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000, assetId: 'asset-ok' }),
      clip({ id: 'b', track: 1, startTimeMs: 0, sourceDurationMs: 1_000, assetId: 'asset-ok' }),
    ]);

    await render(duplicated, port);

    // Two clips, one asset: one question. A per-clip loop would ask twice and, on a large
    // project, turn a mixdown into a query storm.
    expect(asked).toEqual([['asset-ok']]);
  });
});
