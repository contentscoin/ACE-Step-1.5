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
import type { ComposedDsp } from '../../api/gateway/composition';
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

/** The magic every container this test asks for begins with. */
const CONTAINER_MAGIC: Readonly<Record<string, readonly number[]>> = {
  wav: [0x52, 0x49, 0x46, 0x46], // RIFF
  flac: [0x66, 0x4c, 0x61, 0x43], // fLaC
  ogg: [0x4f, 0x67, 0x67, 0x53], // OggS
  mp3: [0xff, 0xfb], // MPEG frame sync
};

/**
 * Whether `bytes` really is an mp3.
 *
 * Two openings are legitimate and which one appears depends on the tags: a file that carries
 * an ID3v2 header — which every download does, because Requirement 13.7 puts a marker in it —
 * begins with `ID3`, and the first MPEG frame comes after it. A bare stream begins with the
 * frame sync. Asserting only the sync would fail on exactly the files the requirement asks for.
 */
function isMp3(bytes: Buffer): boolean {
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
  return bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0;
}

/**
 * A DSP that stands in for the worker on a machine with no sidecar.
 *
 * It satisfies all three interfaces the composition uses, because the composition uses all
 * three. The bytes it returns carry the right container magic so the assertions below are the
 * same ones in both modes; what it cannot stand in for is Requirement 13.7's evidence — a
 * double that reports the tags it was handed is agreeing with itself. That check is real only
 * against the sidecar, which is why CI runs it (`MUSICSTUDIO_DSP_URL`) and why
 * `dsp/test/test_worker.py` pins the read-back on the worker's own side.
 */
function scriptedDsp(): ComposedDsp {
  return {
    normaliseForStorage: async () => ({
      bytes: new Uint8Array([...(CONTAINER_MAGIC.flac ?? []), ...Array.from({ length: 96 }, (_x, i) => i % 251)]),
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
    convertForDownload: async (_audio, format, tags) => ({
      bytes: new Uint8Array([...(CONTAINER_MAGIC[format] ?? []), ...Array.from({ length: 64 }, (_x, i) => i)]),
      format,
      sampleRate: 48_000,
      channels: 2,
      durationMs: 1_000,
      lossless: format === 'wav' || format === 'flac',
      lengthErrorMs: 0,
      tags,
    }),
    waveform: async (_audio, buckets) => ({
      buckets: Array.from({ length: buckets }, (_x, index) => ({
        min: -((index % 10) / 10),
        max: (index % 10) / 10,
      })),
      durationMs: 1_000,
      channels: 2,
      sampleRate: 48_000,
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
  /** Set by the generation case; the S6 cases read the asset it produced. */
  let generated = { assetId: '', accessToken: '' };

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
      // Requirement 13.4 gates lossless downloads on the plan, and the deployment names the
      // plan (there is no billing). `creator` is what a single-tenant install would set, and
      // it is what makes the wav download below reachable; the free-plan refusal is its own
      // case, on its own gateway, because the port answers one plan for every account.
      MUSICSTUDIO_DEFAULT_PLAN_ID: 'creator',
      // Slice S7: the SPA calls from its own origin, so the gateway has to say it may.
      MUSICSTUDIO_CORS_ORIGINS: 'https://studio.test',
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

  async function get(url: string, accessToken: string) {
    return gateway.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${accessToken}` },
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

    generated = { assetId: assetId ?? '', accessToken };
  });

  it('lists, streams and downloads the asset that was just generated', async () => {
    // This is S6's acceptance: the asset a job produced is reachable over HTTP. Before this
    // slice the gateway mounted no library, playback or download routes at all, so everything
    // the previous case stored was invisible to every client.
    const { assetId, accessToken } = generated;
    expect(assetId).not.toBe('');

    // Requirement 11.1 — the owner's listing, newest first, with the asset it just made.
    const listed = await get('/v1/library/assets', accessToken);
    expect(listed.statusCode).toBe(200);
    const page = listed.json<{ assets: { id: string; name: string; playCount: number }[] }>();
    expect(page.assets.map((asset) => asset.id)).toContain(assetId);
    const before = page.assets.find((asset) => asset.id === assetId);
    expect(before?.playCount).toBe(0);

    // Requirement 12.1 — the whole object, as audio, with the play count Requirement 12.4 kept.
    const streamed = await gateway.app.inject({
      method: 'GET',
      url: `/v1/playback/assets/${assetId}/stream`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toBe('audio/flac');
    expect(streamed.headers['accept-ranges']).toBe('bytes');
    expect(streamed.headers['x-play-count']).toBe('1');
    expect(streamed.rawPayload.length).toBeGreaterThan(0);

    // Requirement 12.2, 12.3 — a seek asks the store for that window and answers 206, and
    // Requirement 12.4's counter does not move for it.
    const ranged = await gateway.app.inject({
      method: 'GET',
      url: `/v1/playback/assets/${assetId}/stream`,
      headers: { authorization: `Bearer ${accessToken}`, range: 'bytes=2-5' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toMatch(/^bytes 2-5\//);
    expect(ranged.rawPayload).toHaveLength(4);
    expect(ranged.headers['x-play-count']).toBeUndefined();

    // Requirement 12.6 — an anonymous caller is refused, because nothing is public in this
    // deployment (no sharing store is composed; see `ownerOnlyVisibility`). The status is 404
    // and not 403 on purpose: `playback/errors.ts` argues that a stream URL is reachable
    // without a session, so a 403 would confirm the asset exists. The code tells them apart.
    const anonymous = await gateway.app.inject({
      method: 'GET',
      url: `/v1/playback/assets/${assetId}/stream`,
    });
    expect(anonymous.statusCode).toBe(404);
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('playback_asset_private');

    // Requirement 12.7 — the waveform, at the resolution asked for.
    const waveform = await get(`/v1/playback/assets/${assetId}/waveform?buckets=32`, accessToken);
    expect(waveform.statusCode).toBe(200);
    const drawing = waveform.json<{ buckets: { min: number; max: number }[]; durationMs: number }>();
    expect(drawing.buckets).toHaveLength(32);
    expect(drawing.buckets.every((bucket) => bucket.min <= bucket.max)).toBe(true);

    // Requirements 13.2, 13.8 — what this kind may be downloaded as, before asking for it.
    const formats = await get(`/v1/library/assets/${assetId}/download/formats`, accessToken);
    expect(formats.statusCode).toBe(200);
    expect(formats.json<{ formats: string[] }>().formats).toEqual(['mp3', 'wav', 'flac']);

    // Requirements 13.1, 13.3, 13.6, 13.7, 13.10 — the file itself. This is the sentence the
    // roadmap's S6 row is written around: a download that is real audio.
    const downloaded = await get(
      `/v1/library/assets/${assetId}/download?format=wav`,
      accessToken,
    );
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('audio/wav');
    expect(downloaded.headers['x-sample-rate']).toBe('48000');
    // Requirement 33.19: exactly one of two values, on every download.
    expect(downloaded.headers['x-usage-purpose']).toBe('non_commercial');
    // Requirement 13.6's name — `downloadFileName` builds `<title> (<id>).<ext>` — in both
    // forms of the header, so a client that reads either gets the same file name.
    const disposition = String(downloaded.headers['content-disposition']);
    expect(disposition).toContain(`(${assetId}).wav`);
    expect(disposition).toContain(`filename*=UTF-8''`);
    // RIFF/WAVE. With the real sidecar these are the bytes an encoder produced; with the
    // scripted one they are the container magic it was written to return.
    expect([...downloaded.rawPayload.subarray(0, 4)]).toEqual(CONTAINER_MAGIC.wav);
    if (dspUrl !== undefined) {
      expect(downloaded.rawPayload.subarray(8, 12).toString('ascii')).toBe('WAVE');
    }

    // Requirement 11.5 — the rename a user does after hearing it.
    const renamed = await gateway.app.inject({
      method: 'PATCH',
      url: `/v1/library/assets/${assetId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Rain, Later' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe('Rain, Later');

    // Requirement 11.6 / 11.7 — a deleted asset leaves the listing, and 11.11 brings it back.
    expect(
      (
        await gateway.app.inject({
          method: 'DELETE',
          url: `/v1/library/assets/${assetId}`,
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).statusCode,
    ).toBe(200);
    const afterDelete = await get('/v1/library/assets', accessToken);
    expect(afterDelete.json<{ assets: { id: string }[] }>().assets.map((a) => a.id)).not.toContain(
      assetId,
    );
    expect(
      (
        await gateway.app.inject({
          method: 'POST',
          url: `/v1/library/assets/${assetId}/restore`,
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).statusCode,
    ).toBe(200);
    const afterRestore = await get('/v1/library/assets', accessToken);
    expect(afterRestore.json<{ assets: { id: string }[] }>().assets.map((a) => a.id)).toContain(
      assetId,
    );
  });

  it('keeps a playlist in PostgreSQL, in the order it was given and then reordered', async () => {
    // Requirement 11.10. Two tables and one transaction — see `pg-playlist-store.ts`.
    const { assetId, accessToken } = generated;

    const created = await gateway.app.inject({
      method: 'POST',
      url: '/v1/library/playlists',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Late night', assetIds: [assetId, assetId] },
    });
    expect(created.statusCode).toBe(201);
    const playlist = created.json<{ id: string; assetIds: string[] }>();
    // `playlist_item_unique_asset`: an asset appears once, at its first position.
    expect(playlist.assetIds).toEqual([assetId]);

    const listed = await get('/v1/library/playlists', accessToken);
    expect(listed.json<{ playlists: { id: string }[] }>().playlists.map((p) => p.id)).toEqual([
      playlist.id,
    ]);

    // A reorder replaces the item set rather than appending to it.
    const reordered = await gateway.app.inject({
      method: 'PUT',
      url: `/v1/library/playlists/${playlist.id}/assets`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { assetIds: [assetId] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json<{ assetIds: string[] }>().assetIds).toEqual([assetId]);

    // The rows are really there, in position order.
    const { rows } = await client.query<{ asset_id: string; position: number }>(
      'SELECT asset_id, position FROM playlist_item WHERE playlist_id = $1 ORDER BY position',
      [playlist.id],
    );
    expect(rows).toEqual([{ asset_id: assetId, position: 0 }]);

    expect(
      (
        await gateway.app.inject({
          method: 'DELETE',
          url: `/v1/library/playlists/${playlist.id}`,
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
  });

  it('refuses a lossless download on the free plan, and names the plans that allow it', async () => {
    // Requirement 13.4, on a gateway configured the way an install with no billing starts.
    // A second composition, because the v0 plan port answers one plan for every account —
    // which is exactly what `configured-plan.ts` says it does.
    const freeGateway = composeGateway(
      loadGatewayConfig({
        MUSICSTUDIO_JWT_SECRET: 'composition-test-secret-of-at-least-32-chars',
        MUSICSTUDIO_PUBLIC_BASE_URL: 'https://studio.test',
        MUSICSTUDIO_REDIS_URL: redisUrl,
        MUSICSTUDIO_DATABASE_URL: databaseUrl,
        MUSICSTUDIO_OBJECT_STORE_DIR: root,
        ...(dspUrl === undefined ? {} : { MUSICSTUDIO_DSP_URL: dspUrl }),
      }),
      {
        aceTransport: createScriptedAceTransport(),
        scheduler: createManualScheduler(),
        requestLogging: false,
        log: () => {},
        ...(dspUrl === undefined ? { dsp: scriptedDsp() } : {}),
      },
    );
    try {
      const { assetId, accessToken } = generated;

      const refused = await freeGateway.app.inject({
        method: 'GET',
        url: `/v1/library/assets/${assetId}/download?format=wav`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(refused.statusCode).toBe(402);
      const error = refused.json<{ error: { refusal: string; requiredPlanIds: string[] } }>().error;
      expect(error.refusal).toBe('download_lossless_not_entitled');
      expect(error.requiredPlanIds).toEqual(['creator', 'studio']);

      // The lossy format the free plan does carry still works, so this is a plan gate and not
      // a broken download path.
      const allowed = await freeGateway.app.inject({
        method: 'GET',
        url: `/v1/library/assets/${assetId}/download?format=mp3`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['content-type']).toBe('audio/mpeg');
      expect(isMp3(allowed.rawPayload)).toBe(true);
    } finally {
      await freeGateway.close();
    }
  });

  it('answers a browser preflight for a configured origin, and nothing for another', async () => {
    // Slice S7: the SPA is served from its own origin, so without this every call it makes is
    // refused by the browser before the gateway sees it. The composition above configures
    // `https://studio.test` through `MUSICSTUDIO_CORS_ORIGINS`.
    const allowed = await gateway.app.inject({
      method: 'OPTIONS',
      url: '/v1/library/assets',
      headers: {
        origin: 'https://studio.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(allowed.statusCode).toBeLessThan(300);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://studio.test');
    // The headers the SPA reads off a download it did not originate: 13.6's name, 13.10's rate.
    expect(String(allowed.headers['access-control-expose-headers'])).toContain('content-disposition');

    const refused = await gateway.app.inject({
      method: 'OPTIONS',
      url: '/v1/library/assets',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' },
    });
    // No header rather than an error: the browser refuses the read, which is the outcome, and
    // the gateway says nothing about who else is allowed.
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
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
