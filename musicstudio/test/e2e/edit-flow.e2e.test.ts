import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../adapters/engine-job';
import { BASE_DIT_MODEL, VALID_SOURCE_AUDIO } from '../support/edit-harness';
import {
  createGatewayHarness,
  requireGeneration,
  type GatewayHarness,
} from '../support/gateway-harness';

/**
 * 편집 플로 — 곡 → 커버 → 리페인트 → 스템 추출 → 계보 확인.
 *
 * **Validates: Requirements 7.1, 7.3, 7.6, 7.12**
 *
 * A chain, not three independent edits: each step edits the asset the previous step produced, so
 * the lineage the last step records is three edges deep. That is the claim — `edit-tasks.test.ts`
 * checks each Edit_Task's wire contract one at a time, and a chain can break where the contracts
 * hold, by recording an edge to the *source* of the source rather than to the immediate input.
 */

let harness: GatewayHarness;

const CREDENTIALS = { email: 'editor@studio.test', password: 'correct-horse-battery-staple' };

let token = '';

beforeEach(async () => {
  harness = createGatewayHarness({ generation: { withEditGateway: true } });
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: CREDENTIALS,
  });
  token = login.json<{ accessToken: string }>().accessToken;
});

afterEach(async () => {
  await harness.close();
});

async function edit(kind: string, body: Record<string, unknown>): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/edits/${kind}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  expect(response.statusCode, `${kind}: ${response.body}`).toBe(202);
  return response.json<{ jobId: string }>().jobId;
}

/** Drives a job to success and returns the asset it produced. */
async function finish(jobId: string): Promise<string> {
  const generation = requireGeneration(harness);
  generation.adapter.setResults([
    { audioBuffer: Buffer.from(jobId), sampleRate: 48_000, durationMs: 120_000, seed: 1 },
  ]);
  generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.succeeded });
  await generation.orchestrator.pollOnce(jobId);

  const stored = await generation.store.find(jobId);
  const assetId = stored?.assetIds[0];
  expect(assetId, `job ${jobId} produced no asset`).toBeDefined();

  // The produced asset becomes editable, which is what makes the *next* step of the chain
  // possible. In the product this is the object store the publication path wrote to; here it is
  // the same seam the edit gateway resolves a source through.
  generation.sourceAudio.set({
    ...VALID_SOURCE_AUDIO,
    assetId: assetId ?? '',
    enginePath: `/tmp/ace-uploads/${assetId ?? ''}.wav`,
  });

  return assetId ?? '';
}

describe('커버 → 리페인트 → 스템 추출, 계보가 이어진다', () => {
  it('records one edge per step, each pointing at its immediate input', async () => {
    const generation = requireGeneration(harness);
    const source = VALID_SOURCE_AUDIO.assetId;

    // Requirement 7.1 — a cover of the source.
    const covered = await finish(
      await edit('cover', { sourceAssetId: source, style: { caption: 'acoustic, brushed drums' } }),
    );

    // Requirement 7.3 — a repaint of the *cover*, not of the source.
    const repainted = await finish(
      await edit('repaint', {
        sourceAssetId: covered,
        repaintStartSeconds: 40,
        repaintEndSeconds: 75.5,
      }),
    );

    // Requirement 7.6 — stems extracted from the repaint.
    // The base DiT model, because Requirement 7.6's extraction is not one the turbo model
    // supports — the gateway says so with a 409, which is the product working rather than a
    // detail of the test.
    const extracted = await finish(
      await edit('extract', {
        sourceAssetId: repainted,
        trackName: 'vocals',
        model: BASE_DIT_MODEL,
      }),
    );

    // Requirement 7.12 — three edges, each naming the asset that was actually edited. An
    // implementation that recorded the original source every time would satisfy "an edge exists"
    // and lose the history, which is what the clause is for.
    const edges = generation.lineage.edges;
    expect(edges).toHaveLength(3);
    expect(edges).toContainEqual(
      expect.objectContaining({ parentAssetId: source, childAssetId: covered, derivationType: 'cover' }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        parentAssetId: covered,
        childAssetId: repainted,
        derivationType: 'repaint',
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        parentAssetId: repainted,
        childAssetId: extracted,
        derivationType: 'extract',
      }),
    );

    // And the chain is a chain: following parents from the last asset reaches the first.
    const parentOf = new Map(edges.map((edge) => [edge.childAssetId, edge.parentAssetId]));
    expect(parentOf.get(parentOf.get(parentOf.get(extracted) ?? '') ?? '')).toBe(source);
  });

  it('records nothing for an edit it refused', async () => {
    // A rejected request must not leave a half-written history behind.
    const generation = requireGeneration(harness);

    const refused = await harness.app.inject({
      method: 'POST',
      url: '/v1/edits/cover',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceAssetId: VALID_SOURCE_AUDIO.assetId, coverStrength: 1.5 },
    });

    expect(refused.statusCode).toBe(400);
    expect(generation.lineage.edges).toEqual([]);
  });
});
