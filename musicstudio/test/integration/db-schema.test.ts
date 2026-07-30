import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, loadMigrations, type SqlExecutor } from '../../db/runner';
import { partitionFor, partitionsFrom } from '../../domain/audit-log/partition';

/**
 * Migration acceptance run against a real PostgreSQL 16 (design §12).
 *
 * Skipped unless `MUSICSTUDIO_DATABASE_URL` points at a throwaway database,
 * because the suite creates the whole product schema in the `public` namespace.
 * Everything asserted here is a rule the pure suites also pin, so the pure suites
 * remain the fast feedback loop and this one proves the SQL agrees.
 */

const connectionString = process.env['MUSICSTUDIO_DATABASE_URL'];
const describeDb = connectionString === undefined ? describe.skip : describe;

const provenance = {
  engineId: 'ace-step-1.5',
  weightLicenseId: 'apache-2.0',
  attributionText: 'ACE-Step 1.5',
  commercialUseAllowed: true,
  nonCommercialLicenseListVersion: 1,
  recordedAtMs: 1_800_000_000_000,
  aiGenerated: true,
  qualityThresholdSetVersion: 4,
};

describeDb('PostgreSQL schema (design §4)', () => {
  const client = new Client({ connectionString });
  let accountId = '';

  const executor: SqlExecutor = {
    query: async (sql: string) => ({ rows: (await client.query(sql)).rows }),
  };

  async function insertAsset(options: {
    kind?: string;
    commercial?: boolean;
    parents?: readonly string[];
  }): Promise<string> {
    const commercial = options.commercial ?? true;
    const kind = options.kind ?? 'song';

    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO audio_asset
         (owner_id, name, asset_kind, duration_ms, channels, engine_id,
          commercial_use_allowed, quality_threshold_set_version, provenance)
       VALUES ($1, $2, $3::asset_kind, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        accountId,
        `asset-${Math.random().toString(36).slice(2, 10)}`,
        kind,
        1_000,
        2,
        'ace-step-1.5',
        commercial,
        4,
        JSON.stringify({ ...provenance, commercialUseAllowed: commercial }),
      ],
    );
    const id = inserted.rows[0]?.id ?? '';

    for (const parentId of options.parents ?? []) {
      await client.query(
        `INSERT INTO lineage (child_asset_id, parent_asset_id, derivation_type)
         VALUES ($1, $2, 'effect_apply')`,
        [id, parentId],
      );
    }
    await client.query('COMMIT');

    return id;
  }

  /**
   * JSON `DETAIL` of the rejection (Req 19.13), or `{}` when the statement did
   * not fail. Reading it from the already-settled promise keeps the assertion
   * about *this* rejection rather than a replayed statement.
   */
  async function rejectionDetail(attempt: Promise<unknown>): Promise<string> {
    try {
      await attempt;
      return '{}';
    } catch (error) {
      return (error as { detail?: string }).detail ?? '{}';
    }
  }

  beforeAll(async () => {
    await client.connect();
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await applyMigrations(executor);

    const account = await client.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [`owner-${Date.now()}@studio.example`, '$2b$12$placeholderplaceholderpla'],
    );
    accountId = account.rows[0]?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await client.end();
  });

  it('records every migration and is idempotent on re-run', async () => {
    const applied = await client.query<{ id: string }>('SELECT id FROM schema_migration ORDER BY id');

    expect(applied.rows.map((row) => row.id)).toEqual(
      loadMigrations().map((migration) => migration.id),
    );
    expect(await applyMigrations(executor)).toEqual([]);
  });

  it('creates the five tables of task 1.1', async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['account', 'audio_asset', 'generation_version', 'lineage', 'audit_log']],
    );

    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'account',
      'audio_asset',
      'audit_log',
      'generation_version',
      'lineage',
    ]);
  });

  it('defines Asset_Kind with exactly the six values (Req 19.1)', async () => {
    const values = await client.query<{ label: string }>(
      `SELECT enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'asset_kind' ORDER BY e.enumsortorder`,
    );

    expect(values.rows.map((row) => row.label)).toEqual([
      'song',
      'bgm',
      'sfx',
      'dialogue',
      'stem',
      'mix',
    ]);
  });

  it('rejects an unknown Asset_Kind (Req 19.9)', async () => {
    await expect(insertAsset({ kind: 'podcast' })).rejects.toThrow(/invalid input value for enum/);
    await client.query('ROLLBACK');
  });

  it('rejects a lineage cycle and names the assets (Req 19.13)', async () => {
    const root = await insertAsset({});
    const middle = await insertAsset({ parents: [root] });
    const leaf = await insertAsset({ parents: [middle] });

    await client.query('BEGIN');
    const attempt = client.query(
      `INSERT INTO lineage (child_asset_id, parent_asset_id, derivation_type)
       VALUES ($1, $2, 'cover')`,
      [root, leaf],
    );

    await expect(attempt).rejects.toMatchObject({ code: 'MS019' });
    await client.query('ROLLBACK');

    const detail = await rejectionDetail(attempt);
    const payload = JSON.parse(detail) as { invariant: string; assetIds: string[] };
    expect(payload.invariant).toBe('acyclic');
    expect(payload.assetIds).toEqual([leaf, middle, root, leaf]);

    // Prior lineage is untouched.
    const edges = await client.query<{ count: string }>('SELECT count(*) FROM lineage');
    expect(Number(edges.rows[0]?.count)).toBe(2);
  });

  it('rejects a self derivation by name, not as a degenerate cycle', async () => {
    const asset = await insertAsset({});

    const attempt = client.query(
      `INSERT INTO lineage (child_asset_id, parent_asset_id, derivation_type)
       VALUES ($1, $1, 'cover')`,
      [asset],
    );

    await expect(attempt).rejects.toMatchObject({ code: 'MS019' });
    expect(JSON.parse(await rejectionDetail(attempt))).toMatchObject({
      invariant: 'no_self_derivation',
      assetIds: [asset],
    });
  });

  it('assigns lineage depth and stops at 32 edges (Req 19.7)', async () => {
    let previous = await insertAsset({});
    const chain = [previous];

    for (let step = 0; step < 32; step += 1) {
      previous = await insertAsset({ parents: [previous] });
      chain.push(previous);
    }

    const depths = await client.query<{ depth: number }>(
      'SELECT depth FROM lineage WHERE child_asset_id = ANY($1) ORDER BY depth',
      [chain],
    );
    expect(depths.rows.map((row) => row.depth)).toEqual(
      Array.from({ length: 32 }, (_unused, index) => index + 1),
    );

    const overflow = await insertAsset({});
    await client.query('BEGIN');
    const attempt = client.query(
      `INSERT INTO lineage (child_asset_id, parent_asset_id, derivation_type)
       VALUES ($1, $2, 'cover')`,
      [overflow, previous],
    );
    await expect(attempt).rejects.toMatchObject({ code: 'MS019' });

    const detail = await rejectionDetail(attempt);
    const payload = JSON.parse(detail) as { invariant: string; observed: number };
    expect(payload).toMatchObject({ invariant: 'max_path_depth', observed: 33 });
    await client.query('ROLLBACK');
  }, 60_000);

  it('accepts 64 input assets and rejects the 65th (Req 19.6)', async () => {
    const child = await insertAsset({});
    const parents: string[] = [];
    for (let index = 0; index < 64; index += 1) parents.push(await insertAsset({}));

    for (const parentId of parents) {
      await client.query(
        `INSERT INTO lineage (child_asset_id, parent_asset_id, derivation_type)
         VALUES ($1, $2, 'lego')`,
        [child, parentId],
      );
    }

    const extra = await insertAsset({});
    await client.query('BEGIN');
    const attempt = client.query(
      `INSERT INTO lineage (child_asset_id, parent_asset_id, derivation_type)
       VALUES ($1, $2, 'lego')`,
      [child, extra],
    );
    await expect(attempt).rejects.toMatchObject({ code: 'MS019' });

    const detail = await rejectionDetail(attempt);
    expect(JSON.parse(detail)).toMatchObject({
      invariant: 'max_parents_per_asset',
      limit: 64,
      observed: 65,
    });
    await client.query('ROLLBACK');
  }, 60_000);

  it('requires at least one input for stem and mix (Req 19.7)', async () => {
    await expect(insertAsset({ kind: 'mix' })).rejects.toMatchObject({ code: 'MS019' });
    await client.query('ROLLBACK');

    const source = await insertAsset({});
    await expect(insertAsset({ kind: 'mix', parents: [source] })).resolves.toBeTruthy();
  });

  it('narrows commercial use through lineage at write time (Req 33.20)', async () => {
    const restricted = await insertAsset({ commercial: false });
    const derived = await insertAsset({ commercial: true, parents: [restricted] });
    const grandchild = await insertAsset({ commercial: true, parents: [derived] });

    const flags = await client.query<{ id: string; commercial_use_allowed: boolean }>(
      'SELECT id, commercial_use_allowed FROM audio_asset WHERE id = ANY($1)',
      [[derived, grandchild]],
    );

    for (const row of flags.rows) expect(row.commercial_use_allowed).toBe(false);
  });

  it('keeps the verification query empty (Req 33.21)', async () => {
    const violations = await client.query('SELECT * FROM audio_asset_commercial_use_violation');
    const lineageViolations = await client.query('SELECT * FROM audio_asset_lineage_violation');

    expect(violations.rows).toEqual([]);
    expect(lineageViolations.rows).toEqual([]);
  });

  it('refuses to widen commercial use or rewrite provenance (Req 33.17, 33.7)', async () => {
    const restricted = await insertAsset({ commercial: false });

    await expect(
      client.query('UPDATE audio_asset SET commercial_use_allowed = true WHERE id = $1', [
        restricted,
      ]),
    ).rejects.toMatchObject({ code: 'MS033' });

    await expect(
      client.query(`UPDATE audio_asset SET provenance = '{"engineId":"other"}'::jsonb WHERE id = $1`, [
        restricted,
      ]),
    ).rejects.toMatchObject({ code: 'MS033' });
  });

  it('stores the Quality_Threshold_Set version with the asset (Req 34.6)', async () => {
    const asset = await insertAsset({});
    const stored = await client.query<{ version: number }>(
      'SELECT quality_threshold_set_version AS version FROM audio_asset WHERE id = $1',
      [asset],
    );

    expect(stored.rows[0]?.version).toBe(4);
  });

  it('partitions the audit log by month with the expected names (design §4.4)', async () => {
    const partitions = await client.query<{ relname: string }>(
      `SELECT child.relname FROM pg_inherits i
         JOIN pg_class child ON child.oid = i.inhrelid
         JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname = 'audit_log' ORDER BY child.relname`,
    );

    const previousMonth = new Date();
    previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
    const expected = partitionsFrom(previousMonth, 14).map((partition) => partition.name);

    expect(partitions.rows.map((row) => row.relname)).toEqual(expected);
  });

  it('routes an entry into the partition for its month', async () => {
    await client.query(
      `INSERT INTO audit_log (event_type, actor_id, actor_email_masked, api_key_masked, after_value)
       VALUES ('credit_changed', $1, '***@studio.example', 'sk-***beef', '{"delta":-10}'::jsonb)`,
      [accountId],
    );

    const expectedPartition = partitionFor(new Date()).name;
    const located = await client.query<{ table_name: string }>(
      `SELECT tableoid::regclass::text AS table_name FROM audit_log WHERE actor_id = $1`,
      [accountId],
    );

    expect(located.rows[0]?.table_name).toBe(expectedPartition);
  });

  it('is append-only (design §4.4)', async () => {
    await expect(
      client.query(`UPDATE audit_log SET event_type = 'tampered' WHERE actor_id = $1`, [accountId]),
    ).rejects.toMatchObject({ code: 'MS018' });

    await expect(
      client.query('DELETE FROM audit_log WHERE actor_id = $1', [accountId]),
    ).rejects.toMatchObject({ code: 'MS018' });
  });

  it('rejects unmasked PII in the audit log', async () => {
    await expect(
      client.query(
        `INSERT INTO audit_log (event_type, actor_email_masked) VALUES ('policy_blocked', $1)`,
        ['owner@studio.example'],
      ),
    ).rejects.toThrow(/audit_log_email_masked/);

    await expect(
      client.query(
        `INSERT INTO audit_log (event_type, api_key_masked) VALUES ('api_key_issued', $1)`,
        ['sk-live-8f2a91c4'],
      ),
    ).rejects.toThrow(/audit_log_api_key_masked/);
  });

  it('enforces the 365-day retention floor (design §4.4)', async () => {
    await expect(client.query('SELECT * FROM audit_log_prunable_partitions(364)')).rejects.toMatchObject(
      { code: 'MS018' },
    );

    const prunable = await client.query('SELECT * FROM audit_log_prunable_partitions(365)');
    expect(prunable.rows).toEqual([]);
  });

  it('creates a partition for an arbitrary month on demand', async () => {
    const created = await client.query<{ audit_log_ensure_partition: string }>(
      `SELECT audit_log_ensure_partition('2031-07-09'::date)`,
    );

    expect(created.rows[0]?.audit_log_ensure_partition).toBe('audit_log_2031_07');
    // Idempotent.
    await expect(
      client.query(`SELECT audit_log_ensure_partition('2031-07-20'::date)`),
    ).resolves.toBeTruthy();
  });

  it('allows exactly one default and one original version per asset', async () => {
    const asset = await insertAsset({});
    const insertVersion = (name: string, isDefault: boolean, isOriginal: boolean) =>
      client.query(
        `INSERT INTO generation_version (asset_id, name, is_default, is_original, duration_ms)
         VALUES ($1, $2, $3, $4, 1000)`,
        [asset, name, isDefault, isOriginal],
      );

    await insertVersion('Original', true, true);
    await expect(insertVersion('Second default', true, false)).rejects.toThrow(
      /generation_version_one_default_per_asset/,
    );
    await expect(insertVersion('Second original', false, true)).rejects.toThrow(
      /generation_version_one_original_per_asset/,
    );
    await expect(insertVersion('Alternate', false, false)).resolves.toBeTruthy();
  });
});
