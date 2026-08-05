import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../adapters/engine-job';
import { API_KEY_PREFIX } from '../../domain/public-api/api-key';
import { createWebhookDispatcher } from '../../services/public-api/webhook-dispatcher';
import { createCreditHarness, type CreditHarness } from '../support/credit-harness';
import {
  createGatewayHarness,
  requireGeneration,
  requirePublicApi,
  type GatewayHarness,
} from '../support/gateway-harness';
import {
  recordingWebhookSender,
  sequentialIdSource,
  type RecordingWebhookSender,
} from '../support/public-api-harness';

/**
 * Public_API 플로 — 키 발급 → 웹훅 등록 → 생성 요청 → 완료 → 웹훅 전송 → 크레딧 조회 → 키 폐기.
 *
 * **Validates: Requirements 17.1, 17.5, 17.6, 17.9, 17.10**
 *
 * `test/integration/public-api-routes.test.ts` checks each of these clauses as a contract, one
 * request at a time. What one developer integration actually does is chain them, and two joins
 * only exist once they are chained:
 *
 * - the job the API returned at 17.5 is the job whose completion 17.6 reports **and** whose
 *   result 17.10 delivers — three surfaces naming one identifier;
 * - the URL registered over HTTP is the URL the dispatcher sends to, which is a hand-off
 *   between the API-key store and the dispatcher that neither one's own test can see.
 *
 * ### What is composed here rather than triggered
 *
 * Nothing calls `WebhookDispatcher.onJobTerminal` automatically today: a Generation_Job does not
 * record the API key that submitted it, so the orchestrator has no key to dispatch for. The
 * delivery below is therefore driven from the test, over the **real** dispatcher and the **real**
 * endpoint store the HTTP registration wrote to. That is the honest boundary — the join is
 * exercised, the trigger is not, and `test/e2e/README.md` records it as the gap it is.
 */

let harness: GatewayHarness;
let credit: CreditHarness;
let sender: RecordingWebhookSender;

const CREDENTIALS = { email: 'integrator@studio.test', password: 'correct-horse-battery-staple' };
const WEBHOOK_URL = 'https://hooks.example.com/musicstudio';

beforeEach(() => {
  credit = createCreditHarness();
  sender = recordingWebhookSender();
  harness = createGatewayHarness({
    generation: { withSongGateway: true },
    publicApi: {},
    creditService: credit.service,
  });
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

describe('키 발급 → 웹훅 등록 → 생성 → 완료 통지 → 크레딧 → 폐기', () => {
  it('carries one job identifier across the submit, the poll and the delivery', async () => {
    const { token, accountId } = await signIn();
    const publicApi = requirePublicApi(harness);
    const generation = requireGeneration(harness);
    await credit.service.provisionAccount({ accountId });

    // Requirement 17.1 — issued once, in plaintext, and only now.
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { label: 'my integration' },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const { key, summary } = issued.json<{ key: string; summary: { keyId: string } }>();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);

    // Requirement 17.10's precondition — the endpoint, registered over HTTP.
    const registered = await harness.app.inject({
      method: 'PUT',
      url: `/v1/api-keys/${summary.keyId}/webhook`,
      headers: { authorization: `Bearer ${token}` },
      payload: { url: WEBHOOK_URL },
    });
    expect(registered.statusCode, registered.body).toBe(204);

    // Requirement 17.5 — accepted, identified, and processed asynchronously.
    const submitted = await harness.app.inject({
      method: 'POST',
      url: '/public/v1/generations/song',
      headers: { authorization: `Bearer ${key}` },
      payload: { mode: 'simple', description: 'a warm lo-fi piano beat for studying' },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const { jobId, assetKind } = submitted.json<{ jobId: string; assetKind: string }>();

    // Requirement 17.6 — status, before and after the engine finishes, on the same identifier.
    const pending = await harness.app.inject({
      method: 'GET',
      url: `/public/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(pending.json<{ state: string }>().state).not.toBe('succeeded');

    generation.adapter.setResults([
      { audioBuffer: Buffer.from('a'), sampleRate: 44_100, durationMs: 180_000, seed: 1 },
    ]);
    generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.succeeded });
    await generation.orchestrator.pollOnce(jobId);

    const finished = await harness.app.inject({
      method: 'GET',
      url: `/public/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(finished.statusCode, finished.body).toBe(200);
    const status = finished.json<{ jobId: string; state: string; assetIds: readonly string[] }>();
    expect(status.jobId).toBe(jobId);
    expect(status.state).toBe('succeeded');
    expect(status.assetIds).toHaveLength(1);

    // Requirement 17.10 — the result, sent to the URL registered above. `endpointFor` reads the
    // store the HTTP registration wrote to, so a registration that landed under a different key
    // fails here rather than silently delivering nowhere.
    const dispatcher = createWebhookDispatcher({
      sender,
      ids: sequentialIdSource('delivery'),
      clock: harness.clock,
      endpointFor: (keyId) => publicApi.webhooks.find(keyId),
    });

    const outcome = await dispatcher.onJobTerminal(summary.keyId, {
      jobId,
      state: 'succeeded',
      assetKind: 'song',
      assetIds: status.assetIds,
      failureReason: null,
    });

    expect(outcome.delivered).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.url).toBe(WEBHOOK_URL);
    expect(sender.sent[0]?.payload).toMatchObject({
      event: 'generation_job.completed',
      jobId,
      state: 'succeeded',
      // Requirement 17.14 names the Asset_Kind, and it is the kind the submit returned.
      assetKind,
      assetIds: status.assetIds,
    });

    // Requirement 17.6's third endpoint — the caller's remaining credits, over the key.
    const credits = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/credits',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(credits.statusCode, credits.body).toBe(200);
    expect(credits.json<{ accountId: string }>().accountId).toBe(accountId);

    // Requirement 17.9 — and the key stops working the moment it is revoked, on every one of
    // the endpoints it just used.
    const revoked = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${summary.keyId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json<{ revokedAtMs: number | null }>().revokedAtMs).not.toBeNull();

    for (const url of [`/public/v1/jobs/${jobId}`, '/public/v1/credits']) {
      const after = await harness.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(after.statusCode, `${url}: ${after.body}`).toBe(401);
    }
  });

  it('sends nothing for a key with no endpoint registered', async () => {
    // Requirement 17.10 is scoped 웹훅 URL이 등록된 경우. A delivery to a default endpoint, or a
    // failed attempt reported as an error, would both be wrong for the common case.
    const { token } = await signIn();
    const publicApi = requirePublicApi(harness);

    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { label: 'no webhook' },
    });
    const { summary } = issued.json<{ summary: { keyId: string } }>();

    const dispatcher = createWebhookDispatcher({
      sender,
      ids: sequentialIdSource('delivery'),
      clock: harness.clock,
      endpointFor: (keyId) => publicApi.webhooks.find(keyId),
    });

    const outcome = await dispatcher.onJobTerminal(summary.keyId, {
      jobId: 'job-1',
      state: 'succeeded',
      assetKind: 'song',
      assetIds: ['asset-1'],
      failureReason: null,
    });

    expect(outcome.attempted).toBe(false);
    expect(sender.sent).toEqual([]);
  });
});
