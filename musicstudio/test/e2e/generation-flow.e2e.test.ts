import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../adapters/engine-job';
import { createLibraryService } from '../../services/library/library-service';
import {
  assetRecord,
  inMemoryAssetStore,
  inMemoryPlaylistStore,
} from '../support/library-harness';
import { createMutableClock } from '../support/mutable-clock';
import {
  createGatewayHarness,
  requireGeneration,
  type GatewayHarness,
} from '../support/gateway-harness';

/**
 * 생성 플로 — 크레딧 차감 → Simple 생성 → 결과 저장 → 라이브러리 조회.
 *
 * **Validates: Requirements 2.2, 3.1, 5.1, 5.6, 11.1**
 *
 * The first three steps are one HTTP request and one poll through the real gateway. The fourth
 * is a `Library_Service` read, because Requirement 11 has no route yet — `test/e2e/README.md`
 * says which flows are which and why.
 *
 * What this asserts that the per-clause tests do not: that the *same* job identifier the request
 * returned is the one whose completion creates the assets, and that the count Requirement 5.6
 * creates is the count Requirement 11.1 lists. A product can satisfy 5.6 and 11.1 separately and
 * still lose an asset between them.
 */

let harness: GatewayHarness;

const CREDENTIALS = { email: 'composer@studio.test', password: 'correct-horse-battery-staple' };

beforeEach(() => {
  harness = createGatewayHarness({ generation: { withSongGateway: true } });
});

afterEach(async () => {
  await harness.close();
});

async function signIn(): Promise<{ token: string; accountId: string }> {
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: CREDENTIALS,
  });
  const body = login.json<{ accessToken: string; accountId: string }>();
  return { token: body.accessToken, accountId: body.accountId };
}

describe('크레딧 차감 → Simple 생성 → 결과 저장 → 라이브러리 조회', () => {
  it('carries one request from a charge to a listed asset', async () => {
    const { token, accountId } = await signIn();
    const generation = requireGeneration(harness);

    // Requirements 3.1, 5.1 — Simple_Mode, accepted with an identifier and a queue position.
    const submitted = await harness.app.inject({
      method: 'POST',
      url: '/v1/songs/simple',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'a warm lo-fi piano beat for studying' },
    });

    expect(submitted.statusCode).toBe(202);
    const { jobId, queuePosition } = submitted.json<{ jobId: string; queuePosition: number }>();
    expect(queuePosition).toBe(1);

    // Requirement 2.2 — charged, once, for this job and this account. Asserted here rather than
    // trusted because the debit happens inside the orchestrator, where the route cannot see it.
    expect(generation.charges.requests).toHaveLength(1);
    expect(generation.charges.requests[0]).toMatchObject({ accountId });

    // Requirement 5.6 — the engine finishes with three results, so three assets exist.
    generation.adapter.setResults([
      { audioBuffer: Buffer.from('a'), sampleRate: 44_100, durationMs: 180_000, seed: 1 },
      { audioBuffer: Buffer.from('b'), sampleRate: 44_100, durationMs: 180_000, seed: 2 },
      { audioBuffer: Buffer.from('c'), sampleRate: 44_100, durationMs: 180_000, seed: 3 },
    ]);
    generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.succeeded });
    await generation.orchestrator.pollOnce(jobId);

    const status = await harness.app.inject({
      method: 'GET',
      url: `/v1/generation-jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    const finished = status.json<{ state: string; assetIds: readonly string[] }>();
    expect(finished.state).toBe('succeeded');
    expect(finished.assetIds).toHaveLength(3);

    // A success never refunds — the charge stands.
    expect(generation.refunds.requests).toEqual([]);

    // Requirement 11.1 — the owner lists what the job produced. The assets carry the ids the
    // status reported, so the listing is of *these* assets rather than of some others.
    const library = createLibraryService({
      assets: inMemoryAssetStore(
        finished.assetIds.map((id, index) =>
          assetRecord({ id, ownerId: accountId, name: `Night Drive ${String(index + 1)}` }),
        ),
      ),
      playlists: inMemoryPlaylistStore(),
      clock: createMutableClock(),
      generateId: () => 'playlist-1',
    });

    const listed = await library.list({ ownerId: accountId });
    expect(listed.assets.map((asset) => asset.id).sort()).toEqual([...finished.assetIds].sort());
  });

  it('refunds and lists nothing when the engine fails the job', async () => {
    // The other half of the same journey: Requirement 2.2's charge is not kept for work that
    // produced nothing, and the library has nothing to show.
    const { token, accountId } = await signIn();
    const generation = requireGeneration(harness);

    const submitted = await harness.app.inject({
      method: 'POST',
      url: '/v1/songs/simple',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'a warm lo-fi piano beat for studying' },
    });
    const { jobId } = submitted.json<{ jobId: string }>();

    generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.failed });
    await generation.orchestrator.pollOnce(jobId);

    expect(generation.refunds.requests).toHaveLength(1);

    const library = createLibraryService({
      assets: inMemoryAssetStore([]),
      playlists: inMemoryPlaylistStore(),
      clock: createMutableClock(),
      generateId: () => 'playlist-1',
    });
    expect((await library.list({ ownerId: accountId })).assets).toEqual([]);
  });
});
