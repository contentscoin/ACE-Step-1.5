import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeGateway, type ComposedGateway, type Readiness } from '../../api/gateway/composition';
import { loadGatewayConfig } from '../../api/gateway/config';
import { ACE_STEP_ENGINE_ID } from '../../adapters/registry/default-engines';
import { applyMigrations, loadMigrations, type SqlExecutor } from '../../db/runner';
import { watermarkId } from '../../domain/disclosure/ai-disclosure';
import type { DspClient } from '../../services/generation/adapters/dsp-http-client';
import { objectKeyFor } from '../../services/generation/adapters/pg-asset-publication';
import type { JobStatusView } from '../../services/generation/job-status';
import { createFilesystemObjectStore } from '../../services/playback/adapters/filesystem-object-store';
import { createManualScheduler, type ManualScheduler } from '../support/registry-harness';
import { createScriptedAceTransport, type ScriptedAceTransport } from '../support/scripted-ace-transport';
import { wavBytes } from '../support/wav-fixture';

/**
 * The composition root, composed (slice S5).
 *
 * Every other integration test in this directory proves one adapter against one server. This
 * one calls the function `npm start` calls, against the real PostgreSQL and Redis the CI
 * `database` job provides, and walks one user from `/auth/register` to a stored, watermarked
 * asset — the path the roadmap's S6 describes with `curl`, run here with `app.inject()`.
 *
 * Two things are not real, and both are the test's seams rather than the composition's:
 *
 * - The engine is the scripted ACE transport. There is no GPU in CI; what the script provides
 *   is a `/release_task` acknowledgement, a `/query_result` that says "done, here is a file",
 *   and the bytes of that file. The adapter, the poll loop, the result decoding and the
 *   publication are all the production code.
 * - The scheduler is manual, so the Requirement 5.2 poll runs when the test runs it rather than
 *   five real seconds later.
 *
 * The DSP is real when `MUSICSTUDIO_DSP_URL` is set — the CI job starts the sidecar — and
 * scripted otherwise, so the case still runs on a developer machine with only the two stores.
 *
 * Gated on both store URLs; without either it skips, like its neighbours.
 */

const databaseUrl = process.env['MUSICSTUDIO_DATABASE_URL'];
const redisUrl = process.env['MUSICSTUDIO_REDIS_URL'];
const dspUrl = process.env['MUSICSTUDIO_DSP_URL'];
const describeComposed = databaseUrl === undefined || redisUrl === undefined ? describe.skip : describe;

const CREDENTIALS = { email: 'composer@studio.test', password: 'correct-horse-battery-staple' };
const ENGINE_FILE = '/outputs/ace-task-7.wav';

/** A DSP that returns FLAC-looking bytes and reports the watermark scheme it "applied". */
function scriptedDsp(): DspClient {
  return {
    normaliseForStorage: async () => ({
      bytes: new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...Array.from({ length: 96 }, (_x, i) => i % 251)]),
      audioFormat: 'flac',
      durationMs: 1_000,
      sampleRate: 48_000,
      channels: 2,
      originalSampleRate: 22_050,
      originalDurationMs: 1_000,
      lengthErrorMs: 0,
      resampled: true,
      watermarkVersion: 1,
    }),
  };
}

describeComposed('the composition root against PostgreSQL, Redis and a scripted engine', () => {
  const client = new Client({ connectionString: databaseUrl });
  let root = '';
  let gateway: ComposedGateway;
  let transport: ScriptedAceTransport;
  let scheduler: ManualScheduler;
  const logged: Record<string, unknown>[] = [];

  beforeAll(async () => {
    await client.connect();
    const executor: SqlExecutor = {
      query: async (sql: string) => ({ rows: (await client.query(sql)).rows }),
    };
    await applyMigrations(executor, loadMigrations());
    await client.query('TRUNCATE account CASCADE');

    root = await mkdtemp(join(tmpdir(), 'musicstudio-compose-'));
    transport = createScriptedAceTransport();
    scheduler = createManualScheduler();

    const config = loadGatewayConfig({
      MUSICSTUDIO_JWT_SECRET: 'composition-test-secret-of-at-least-32-chars',
      MUSICSTUDIO_PUBLIC_BASE_URL: 'https://studio.test',
      MUSICSTUDIO_REDIS_URL: redisUrl,
      MUSICSTUDIO_DATABASE_URL: databaseUrl,
      MUSICSTUDIO_OBJECT_STORE_DIR: root,
      ...(dspUrl === undefined ? {} : { MUSICSTUDIO_DSP_URL: dspUrl }),
      // The engine URL is never contacted — the transport is scripted — but it is what a
      // deployment would set, and the config must accept it.
      MUSICSTUDIO_ENGINE_URL: 'http://127.0.0.1:8001',
    });

    gateway = composeGateway(config, {
      aceTransport: transport,
      scheduler,
      requestLogging: false,
      log: (record) => logged.push({ ...record }),
      ...(dspUrl === undefined ? { dsp: scriptedDsp() } : {}),
    });
    await gateway.start();
  });

  afterAll(async () => {
    await gateway.close();
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  async function post(url: string, payload: Record<string, unknown>, accessToken?: string) {
    return gateway.app.inject({
      method: 'POST',
      url,
      payload,
      ...(accessToken === undefined ? {} : { headers: { authorization: `Bearer ${accessToken}` } }),
    });
  }

  async function status(jobId: string, accessToken: string): Promise<JobStatusView> {
    const response = await gateway.app.inject({
      method: 'GET',
      url: `/v1/generation-jobs/${jobId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<JobStatusView>();
  }

  /**
   * Runs the manual scheduler until `done` holds or the budget is spent. Each turn runs one
   * queued task and then yields to real time briefly: a poll that reached the real sidecar is
   * HTTP, and its promise chain needs the loop to turn before the next task is meaningful.
   */
  async function driveUntil(done: () => Promise<boolean>, turns = 200): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
      if (await done()) return;
      scheduler.runNext();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the scheduler was drained without reaching the expected state');
  }

  it('answers liveness and readiness, with the engine routable after the boot probes', async () => {
    const health = await gateway.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const ready = await gateway.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    const readiness = ready.json<Readiness>();
    expect(readiness.checks.database).toBe('ok');
    expect(readiness.checks.redis).toBe('ok');
    expect(readiness.checks.engine).toBe('available');
    expect(readiness.checks.engineLastCheck).toBe('success');
    expect(readiness.checks.dsp).toBe(dspUrl === undefined ? 'skipped' : 'ok');
    expect(readiness.status).toBe('ready');

    // The registry's view agrees, and the engine it holds is the one the catalogue described.
    const [ace] = gateway.registry.listEngines();
    expect(ace?.engineId).toBe(ACE_STEP_ENGINE_ID);
    expect(ace?.availableNow).toBe(true);
    // Requirement 20.8's threshold, probed at boot — see `ComposedGateway.start`.
    expect(transport.jsonRequests.filter((request) => request.path === '/health')).toHaveLength(3);
  });

  it('carries a song from registration to a stored, watermarked asset', async () => {
    // Requirement 1.1 / 1.3 through the real bcrypt hasher, the real table and the real Redis.
    expect((await post('/v1/auth/register', CREDENTIALS)).statusCode).toBe(201);
    const login = await post('/v1/auth/login', CREDENTIALS);
    expect(login.statusCode).toBe(200);
    const { accessToken, accountId } = login.json<{ accessToken: string; accountId: string }>();

    // The engine will acknowledge, report success on the first poll, and serve one file.
    transport.setTaskId('ace-task-7', 1);
    transport.setDefaultResult({
      statusCode: 1,
      audios: [{ file: ENGINE_FILE, metadata: { caption: 'calm piano over rain', bpm: 72 } }],
    });
    transport.setAudio(ENGINE_FILE, Buffer.from(wavBytes()));

    // Requirement 3: Simple_Mode, through the route, the gateway and the orchestrator.
    const submitted = await post(
      '/v1/songs/simple',
      { description: 'a calm piano piece over soft rain', durationSeconds: 30 },
      accessToken,
    );
    expect(submitted.statusCode).toBe(202);
    const acceptance = submitted.json<{ jobId: string; engineId: string; state: string }>();
    expect(acceptance.engineId).toBe(ACE_STEP_ENGINE_ID);
    expect(acceptance.state).toBe('pending');
    expect(transport.onlyRequestTo('/release_task').body).toMatchObject({ sample_mode: true });

    // Nobody called `pollOnce`. The composition polls on its own — this is the S5 gap closed.
    expect(gateway.orchestrator.pollingJobIds).toEqual([acceptance.jobId]);
    await driveUntil(async () => (await status(acceptance.jobId, accessToken)).state === 'succeeded');

    const view = await status(acceptance.jobId, accessToken);
    expect(view.assetIds).toHaveLength(1);
    expect(gateway.orchestrator.pollingJobIds).toEqual([]);
    const [assetId] = view.assetIds;

    // The row: owned by the account that logged in, produced by the engine that was routed,
    // carrying the provenance the registry and the sidecar agreed on.
    const { rows } = await client.query<{
      owner_id: string;
      engine_id: string;
      object_key: string;
      sample_rate: number;
      provenance: { watermarkId: string; weightLicenseId: string; commercialUseAllowed: boolean };
    }>('SELECT owner_id, engine_id, object_key, sample_rate, provenance FROM audio_asset WHERE id = $1', [assetId]);
    const row = rows[0];
    expect(row?.owner_id).toBe(accountId);
    expect(row?.engine_id).toBe(ACE_STEP_ENGINE_ID);
    expect(row?.object_key).toBe(objectKeyFor(assetId ?? ''));
    expect(row?.sample_rate).toBe(48_000);
    expect(row?.provenance.watermarkId).toBe(watermarkId(1));
    expect(row?.provenance.weightLicenseId).toBe('MIT');
    expect(row?.provenance.commercialUseAllowed).toBe(true);

    // The object: present, typed, and — with the real sidecar — an actual FLAC container.
    const objects = createFilesystemObjectStore(root);
    const head = await objects.head(row?.object_key ?? '');
    expect(head).not.toBeNull();
    expect(head?.contentType).toBe('audio/flac');
    if (dspUrl !== undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of await objects.read({ objectKey: row?.object_key ?? '', start: 0, end: 3 })) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      expect(Buffer.concat(chunks).toString('ascii')).toBe('fLaC');
    }

    // The engine was asked for exactly the file it named, and nothing was charged (v0).
    expect(transport.binaryRequests.map((request) => request.query.path)).toEqual([ENGINE_FILE]);
    expect(logged.some((record) => record.event === 'gateway.composed')).toBe(true);
  });

  it('refuses a request nobody is signed in for, and a song outside Requirement 4.2', async () => {
    expect((await post('/v1/songs/simple', { description: 'x' })).statusCode).toBe(401);

    const login = await post('/v1/auth/login', CREDENTIALS);
    const { accessToken } = login.json<{ accessToken: string }>();
    const tooLong = await post('/v1/songs/simple', { description: 'x', durationSeconds: 601 }, accessToken);
    expect(tooLong.statusCode).toBe(400);
    // Nothing reached the engine for it: one `/release_task` in the whole file, from the case above.
    expect(transport.jsonRequests.filter((request) => request.path === '/release_task')).toHaveLength(1);
  });

  it('reports a dead engine as unavailable before the listener opens, not a minute later', async () => {
    // A second composition over the same stores, whose engine never answers. The registry
    // registers an engine `available` (20.8 needs three failures to say otherwise), which is
    // exactly the window boot has to close: a gateway that said `ready` here would route the
    // first minute of requests to nothing and fail them one by one.
    //
    // Runs after the song case, whose registration is the account this one logs in with —
    // both gateways share the account table and the session store.
    const deadEngine = createScriptedAceTransport();
    deadEngine.setHealthy(false);
    const second = composeGateway(
      loadGatewayConfig({
        MUSICSTUDIO_JWT_SECRET: 'composition-test-secret-of-at-least-32-chars',
        MUSICSTUDIO_PUBLIC_BASE_URL: 'https://studio.test',
        MUSICSTUDIO_REDIS_URL: redisUrl,
        MUSICSTUDIO_DATABASE_URL: databaseUrl,
        MUSICSTUDIO_OBJECT_STORE_DIR: root,
      }),
      { aceTransport: deadEngine, scheduler: createManualScheduler(), requestLogging: false, log: () => {}, dsp: scriptedDsp() },
    );
    try {
      await second.start();
      const ready = await second.app.inject({ method: 'GET', url: '/ready' });
      // The stores are fine, so the process is up (200); it is the engine that is not.
      expect(ready.statusCode).toBe(200);
      const readiness = ready.json<Readiness>();
      expect(readiness.status).toBe('degraded');
      expect(readiness.checks.engine).toBe('unavailable');
      expect(readiness.checks.engineLastCheck).toBe('failure');
      expect(readiness.checks.database).toBe('ok');

      // And routing agrees: Requirement 6.6's maintenance notice, not an engine call.
      const login = await post('/v1/auth/login', CREDENTIALS);
      const { accessToken } = login.json<{ accessToken: string }>();
      const refused = await second.app.inject({
        method: 'POST',
        url: '/v1/songs/simple',
        payload: { description: 'anything', durationSeconds: 30 },
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('no_available_engine');
      expect(deadEngine.jsonRequests.filter((request) => request.path === '/release_task')).toHaveLength(0);
    } finally {
      await second.close();
    }
  });
});
