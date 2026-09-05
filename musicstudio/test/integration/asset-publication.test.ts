import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, loadMigrations, type SqlExecutor } from '../../db/runner';
import { watermarkId } from '../../domain/disclosure/ai-disclosure';
import { validateProvenance, type AssetProvenance } from '../../domain/provenance';
import { createFilesystemObjectStore } from '../../services/playback/adapters/filesystem-object-store';
import {
  AssetPublicationRejected,
  createPgAssetPublication,
  EngineLicenseUnknown,
  objectKeyFor,
} from '../../services/generation/adapters/pg-asset-publication';
import type { DspClient, NormalisedAudio } from '../../services/generation/adapters/dsp-http-client';
import { createInMemoryJobStore } from '../../services/generation/job-store';
import type { NormalizedGenerationResult } from '../../adapters/normalized-generation';
import type { AssetPublicationRequest } from '../../services/generation/ports';

/**
 * The publication path against a real database and a real object store (S3).
 *
 * The DSP is the one thing scripted here, because a TypeScript test cannot import the Python
 * pipeline; the sidecar round-trip lives in `dsp-sidecar-roundtrip.test.ts` and is gated on its
 * own URL. Everything else is the real thing: the row goes into PostgreSQL through the same
 * migrations CI applies, the bytes go into a directory through the S1 store, and the assertions
 * read both back — the row's `object_key` has to resolve to an object whose length is the bytes
 * the DSP returned, or the asset exists without its audio and nothing downstream can play it.
 *
 * Skips without `MUSICSTUDIO_DATABASE_URL`, like every database test here, and runs in the CI
 * `database` job through `test:db`.
 */

const connectionString = process.env['MUSICSTUDIO_DATABASE_URL'];
const describeDb = connectionString === undefined ? describe.skip : describe;

const OWNER = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const ENGINE = 'ace-step-1.5';

/** A DSP that returns what it was told to, and remembers what it was given. */
function scriptedDsp(overrides: Partial<NormalisedAudio> = {}): DspClient & { inputs: Uint8Array[] } {
  const inputs: Uint8Array[] = [];
  return {
    inputs,
    normaliseForStorage: async (audio) => {
      inputs.push(audio);
      return {
        bytes: new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...Array.from({ length: 60 }, (_x, i) => i)]),
        audioFormat: 'flac',
        durationMs: 3_000,
        sampleRate: 48_000,
        channels: 2,
        originalSampleRate: 44_100,
        originalDurationMs: 3_000,
        lengthErrorMs: 0,
        resampled: true,
        watermarkVersion: 1,
        ...overrides,
      };
    },
  };
}

function result(overrides: Partial<NormalizedGenerationResult> = {}): NormalizedGenerationResult {
  return {
    assetKind: 'song',
    durationMs: 3_000,
    sampleRate: 44_100,
    seed: 42,
    engineId: ENGINE,
    status: 'success',
    audioBuffer: Buffer.from('engine-output'),
    originalSampleRate: 44_100,
    ...overrides,
  };
}

function request(results: readonly NormalizedGenerationResult[]): AssetPublicationRequest {
  return { accountId: OWNER, jobId: JOB, assetKind: 'song', engineId: ENGINE, results };
}

const LICENSE = {
  license: {
    codeLicenseId: 'apache-2.0',
    weightLicenseId: 'apache-2.0',
    commercialUseAllowed: true,
    attributionText: 'ACE-Step 1.5',
    licenseUrls: ['https://example.test/license'],
  },
  nonCommercialLicenseListVersion: 1,
};

describeDb('AssetPublicationPort over PostgreSQL and the filesystem store', () => {
  const client = new Client({ connectionString });
  const roots: string[] = [];

  beforeAll(async () => {
    await client.connect();
    const executor: SqlExecutor = {
      query: async (sql: string) => ({ rows: (await client.query(sql)).rows }),
    };
    await applyMigrations(executor, loadMigrations());
  });

  afterEach(async () => {
    await client.query('TRUNCATE account CASCADE');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await client.end();
  });

  async function setup(options: { dsp?: DspClient; withJob?: boolean } = {}) {
    await client.query(
      `INSERT INTO account (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`,
      [OWNER, 'owner@example.com'],
    );
    const root = await mkdtemp(join(tmpdir(), 'musicstudio-publish-'));
    roots.push(root);
    const objects = createFilesystemObjectStore(root);

    const jobs = createInMemoryJobStore();
    if (options.withJob === true) {
      await jobs.save({
        jobId: JOB,
        accountId: OWNER,
        input: {
          accountId: OWNER,
          assetKind: 'song',
          inputModality: 'text',
          durationMs: 3_000,
          song: { mode: 'custom', sampleMode: false, instrumental: false, thinking: true, batchSize: 1, caption: '  Late night   drive through neon rain  ' },
        },
        engineId: ENGINE,
        engineJobId: null,
        lifecycle: { state: 'running', enteredAtMs: 0 } as never,
        acceptedAtMs: 0,
        updatedAtMs: 0,
        debitedAmount: 0,
        attemptsMade: 1,
        unreachableStreak: 0,
        progressPercent: null,
        retryOfJobId: null,
        assetIds: [],
        eventSequence: 0,
      });
    }

    const publication = createPgAssetPublication({
      db: client,
      objects,
      dsp: options.dsp ?? scriptedDsp(),
      licenses: { licenseFor: (engineId) => (engineId === ENGINE ? LICENSE : null) },
      disclosure: { provenanceFieldsFor: (v) => ({ aiGenerated: true, watermarkId: watermarkId(v) }) },
      clock: { now: () => new Date(1_800_000_000_000) },
      jobs,
    });
    return { objects, publication };
  }

  async function row(id: string) {
    const { rows } = await client.query<{
      owner_id: string;
      name: string;
      asset_kind: string;
      duration_ms: number;
      sample_rate: number;
      channels: number;
      seed: string;
      commercial_use_allowed: boolean;
      provenance: AssetProvenance;
      object_key: string | null;
      is_deleted: boolean;
    }>(`SELECT * FROM audio_asset WHERE id = $1`, [id]);
    return rows[0];
  }

  it('stores the normalised bytes and a row whose object_key resolves to them', async () => {
    const dsp = scriptedDsp();
    const { objects, publication } = await setup({ dsp });

    const [id] = await publication.publish(request([result()]));
    expect(id).toBeDefined();

    const stored = await row(id as string);
    expect(stored?.object_key).toBe(objectKeyFor(id as string));
    expect(stored?.owner_id).toBe(OWNER);
    expect(stored?.asset_kind).toBe('song');
    expect(stored?.sample_rate).toBe(48_000);
    expect(stored?.channels).toBe(2);
    expect(stored?.duration_ms).toBe(3_000);
    expect(Number(stored?.seed)).toBe(42);
    expect(stored?.is_deleted).toBe(false);

    // The bytes the DSP returned are the bytes in the store, under the key the row names.
    const head = await objects.head(stored?.object_key as string);
    expect(head).toEqual({ contentLength: 64, contentType: 'audio/flac' });

    // And the DSP was handed the engine's output, not something else.
    expect(Buffer.from(dsp.inputs[0] as Uint8Array).toString()).toBe('engine-output');
  });

  it('writes provenance the domain accepts and the database checks, with the reported watermark', async () => {
    const { publication } = await setup({ dsp: scriptedDsp({ watermarkVersion: 3 }) });
    const [id] = await publication.publish(request([result()]));
    const stored = await row(id as string);

    expect(validateProvenance(stored?.provenance as AssetProvenance)).toEqual([]);
    expect(stored?.provenance.aiGenerated).toBe(true);
    // Requirement 33.14: the id records the scheme that marked *these* bytes — version 3, not 1.
    expect(stored?.provenance.watermarkId).toBe(watermarkId(3));
    expect(stored?.provenance.weightLicenseId).toBe('apache-2.0');
    expect(stored?.provenance.attributionText).toBe('ACE-Step 1.5');
    expect(stored?.provenance.recordedAtMs).toBe(1_800_000_000_000);
    expect(stored?.commercial_use_allowed).toBe(true);
  });

  it('names the asset from the job caption when the job is known, cleaned and numbered', async () => {
    const { publication } = await setup({ withJob: true });
    const ids = await publication.publish(request([result(), result({ seed: 43 })]));
    expect(ids).toHaveLength(2);

    expect((await row(ids[0] as string))?.name).toBe('Late night drive through neon rain 1');
    expect((await row(ids[1] as string))?.name).toBe('Late night drive through neon rain 2');
  });

  it('falls back to a kind-and-job label when there is no job to read', async () => {
    const { publication } = await setup();
    const [id] = await publication.publish(request([result()]));
    expect((await row(id as string))?.name).toBe(`song ${JOB.slice(0, 8)}`);
  });

  it('publishes only successful results, in order, and reports that many ids', async () => {
    const { publication } = await setup();
    const ids = await publication.publish(
      request([result({ seed: 1 }), result({ status: 'failed', seed: 2 }), result({ seed: 3 })]),
    );
    expect(ids).toHaveLength(2);
    expect(Number((await row(ids[0] as string))?.seed)).toBe(1);
    expect(Number((await row(ids[1] as string))?.seed)).toBe(3);
  });

  it('refuses in the domain vocabulary before writing anything, when the DSP reports a bad shape', async () => {
    // Three channels: the schema says 1 or 2 and so does `validateAudioAsset`. The refusal has
    // to come from the domain — naming `channels_range` — and leave no object behind.
    const { objects, publication } = await setup({ dsp: scriptedDsp({ channels: 3 }) });

    await expect(publication.publish(request([result()]))).rejects.toBeInstanceOf(AssetPublicationRejected);
    await expect(publication.publish(request([result()]))).rejects.toMatchObject({
      violations: expect.arrayContaining(['channels_range']),
    });

    const { rows } = await client.query(`SELECT count(*)::int AS n FROM audio_asset`);
    expect((rows[0] as { n: number }).n).toBe(0);
    // Nothing under audio/: the store root only ever gets a directory when a put happens.
    expect(await objects.head('audio/anything')).toBeNull();
  });

  it('removes the object when the row cannot be written, so no orphan bytes remain', async () => {
    // A duration the domain accepts (validateAudioAsset's ceiling is generous) but the schema
    // refuses: `audio_asset_duration_range` caps at 3_600_000 ms. The insert fails after the
    // put, and the port has to take the object back out.
    const dsp = scriptedDsp({ durationMs: 4_000_000 });
    const { objects, publication } = await setup({ dsp });
    const ids: string[] = [];
    const capturing = createPgAssetPublication({
      db: client,
      objects,
      dsp,
      licenses: { licenseFor: () => LICENSE },
      disclosure: { provenanceFieldsFor: (v) => ({ aiGenerated: true, watermarkId: watermarkId(v) }) },
      clock: { now: () => new Date(0) },
      newId: () => {
        const id = '33333333-3333-4333-8333-333333333333';
        ids.push(id);
        return id;
      },
    });
    void publication;

    await expect(capturing.publish(request([result()]))).rejects.toThrow();
    expect(ids).toHaveLength(1);
    expect(await objects.head(objectKeyFor(ids[0] as string))).toBeNull();
  });

  it('refuses an engine with no registered licence before touching the DSP', async () => {
    const dsp = scriptedDsp();
    const { publication } = await setup({ dsp });
    await expect(
      publication.publish({ ...request([result()]), engineId: 'unknown-engine' }),
    ).rejects.toBeInstanceOf(EngineLicenseUnknown);
    expect(dsp.inputs).toHaveLength(0);
  });
});
