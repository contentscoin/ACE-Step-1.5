import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../adapters/engine-job';
import { JOB_TIMEOUT_MS } from '../../domain/generation-job/timeout';
import {
  createGatewayHarness,
  requireGeneration,
  type GatewayHarness,
} from '../support/gateway-harness';

/**
 * Generation_Job routes through the real gateway (Requirements 5.1, 5.3, 5.4, 5.5,
 * 5.7, 5.8, 6.1, 6.4, 6.6).
 *
 * The orchestrator's own behaviour is covered in
 * `test/unit/generation/job-orchestrator.test.ts`; what is asserted here is the HTTP
 * contract — status codes, the shared error envelope, ownership checks, and that the
 * SSE endpoint negotiates a real event stream.
 */

let harness: GatewayHarness;

async function signIn(email = 'creator@example.com'): Promise<string> {
  const password = 'correct-horse-battery-staple';
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  return login.json<{ accessToken: string }>().accessToken;
}

async function submitJob(token: string, overrides: Record<string, unknown> = {}) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/generation-jobs',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      assetKind: 'song',
      inputModality: 'text',
      durationMs: 120_000,
      prompt: 'a calm piano piece',
      ...overrides,
    },
  });
}

beforeEach(() => {
  harness = createGatewayHarness({ generation: {} });
});

afterEach(async () => {
  await harness.close();
});

describe('Requirement 5.1 — POST /generation-jobs', () => {
  it('accepts the job and returns its id, engine job id and queue position', async () => {
    const token = await signIn();

    const response = await submitJob(token);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      queuePosition: 1,
      state: 'pending',
      engineId: 'ace-step-test',
      substitutedEngine: false,
    });
    expect(response.json<{ engineJobId: string }>().engineJobId).toMatch(/-job-1$/);
  });

  it('rejects an unauthenticated submission', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/generation-jobs',
      payload: { assetKind: 'song', inputModality: 'text', durationMs: 1_000 },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed body through the schema, not the service', async () => {
    const token = await signIn();
    const generation = requireGeneration(harness);

    const response = await submitJob(token, { assetKind: 'not-a-kind' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    // Rejected at the edge: nothing was charged and no engine was contacted.
    expect(generation.charges.requests).toHaveLength(0);
    expect(generation.adapter.submitCount).toBe(0);
  });
});

describe('Requirements 5.3, 5.5 — GET /generation-jobs/:jobId', () => {
  it('reports the user-visible state and an expected completion time', async () => {
    const token = await signIn();
    const { jobId } = (await submitJob(token)).json<{ jobId: string }>();

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/generation-jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      state: string;
      queuePosition: number;
      estimatedCompletionAtMs: number;
      deadlineAtMs: number;
      acceptedAtMs: number;
    }>();
    expect(body.state).toBe('pending');
    expect(body.queuePosition).toBe(1);
    expect(body.estimatedCompletionAtMs).toBeGreaterThan(body.acceptedAtMs);
    expect(body.deadlineAtMs - body.acceptedAtMs).toBe(JOB_TIMEOUT_MS);
  });

  it('returns 404 for an unknown job and 403 for another account s job', async () => {
    const owner = await signIn('owner@example.com');
    const { jobId } = (await submitJob(owner)).json<{ jobId: string }>();
    const stranger = await signIn('stranger@example.com');

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/v1/generation-jobs/not-a-job',
      headers: { authorization: `Bearer ${owner}` },
    });
    const forbidden = await harness.app.inject({
      method: 'GET',
      url: `/v1/generation-jobs/${jobId}`,
      headers: { authorization: `Bearer ${stranger}` },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('generation_job_not_found');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<{ error: { code: string } }>().error.code).toBe('generation_job_forbidden');
  });
});

describe('Requirement 5.7 — POST /generation-jobs/:jobId/cancel', () => {
  it('cancels a pending job and refunds it', async () => {
    const token = await signIn();
    const generation = requireGeneration(harness);
    const { jobId } = (await submitJob(token)).json<{ jobId: string }>();

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/generation-jobs/${jobId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'cancelled', queuePosition: null });
    expect(generation.refunds.requests).toHaveLength(1);
  });

  it('returns 409 once the engine has started the job', async () => {
    const token = await signIn();
    const generation = requireGeneration(harness);
    const { jobId } = (await submitJob(token)).json<{ jobId: string }>();
    generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.running });
    await generation.orchestrator.pollOnce(jobId);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/generation-jobs/${jobId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'generation_job_not_cancellable',
    );
  });
});

describe('Requirement 6.4 — POST /generation-jobs/:jobId/retry', () => {
  it('creates a new job with identical input parameters', async () => {
    const token = await signIn();
    const generation = requireGeneration(harness);
    const { jobId } = (await submitJob(token)).json<{ jobId: string }>();
    generation.adapter.setDefaultPoll({
      state: ENGINE_JOB_STATE.failed,
      failureReason: 'engine overload',
    });
    await generation.orchestrator.pollOnce(jobId);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/generation-jobs/${jobId}/retry`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(202);
    const retriedId = response.json<{ jobId: string }>().jobId;
    expect(retriedId).not.toBe(jobId);
    const original = await generation.store.find(jobId);
    const replacement = await generation.store.find(retriedId);
    expect(replacement?.input).toEqual(original?.input);
  });

  it('returns 409 when the job never failed', async () => {
    const token = await signIn();
    const { jobId } = (await submitJob(token)).json<{ jobId: string }>();

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/generation-jobs/${jobId}/retry`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('Requirement 6.1 — an engine that refuses every attempt', () => {
  it('answers 422 with the classification and retryability', async () => {
    const token = await signIn();
    const generation = requireGeneration(harness);
    generation.adapter.failSubmit(Object.assign(new Error('caption invalid'), { statusCode: 400 }), 5);

    const response = await submitJob(token);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: 'generation_job_failed',
        classification: 'input_error',
        retryable: false,
      },
    });
  });
});

describe('Requirement 6.6 — no healthy engine for the Asset_Kind', () => {
  it('answers 503 with each candidate s last check result', async () => {
    await harness.close();
    harness = createGatewayHarness({ generation: { withoutEngine: true } });
    const token = await signIn();

    const response = await submitJob(token);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'no_available_engine', assetKind: 'song' },
    });
  });
});

describe('Requirement 5.4 — GET /generation-jobs/:jobId/events', () => {
  it('refuses a stream for another account s job before opening it', async () => {
    const owner = await signIn('owner2@example.com');
    const { jobId } = (await submitJob(owner)).json<{ jobId: string }>();
    const stranger = await signIn('stranger2@example.com');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/generation-jobs/${jobId}/events`,
      headers: { authorization: `Bearer ${stranger}` },
    });

    // A JSON error, not a half-opened event stream.
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('negotiates an event stream and pushes the current state immediately', async () => {
    const token = await signIn();
    const generation = requireGeneration(harness);
    const { jobId } = (await submitJob(token)).json<{ jobId: string }>();
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const address = harness.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no bound port');

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${String(address.port)}/v1/generation-jobs/${jobId}/events`,
      { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no response body');
    const decoder = new TextDecoder();

    // Frame 1: the snapshot sent on connect, which proves the stream is live
    // before any transition happens.
    const snapshot = decoder.decode((await reader.read()).value);
    expect(snapshot).toContain('event: job-status');
    expect(snapshot).toContain('"state":"pending"');

    // Frame 2: the Requirement 5.4 push for an actual state change.
    generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.running });
    const pushed = generation.orchestrator.pollOnce(jobId);
    const change = decoder.decode((await reader.read()).value);
    await pushed;

    expect(change).toContain('"state":"running"');

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
