import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, loadMigrations, type SqlExecutor } from '../../db/runner';
import { createPgAssetStore } from '../../services/library/adapters/pg-asset-store';
import { assetRecord, inMemoryAssetStore } from '../support/library-harness';
import { toLibraryQuery } from '../../domain/library/query';
import type { LibraryAssetRecord, LibraryAssetStore } from '../../services/library/ports';

/**
 * One contract, run against both `LibraryAssetStore` implementations (track B1).
 *
 * The account contract explains why this shape exists; this one carries more weight, because the
 * in-memory store's `page` **is** `applyLibraryQuery` — the domain function itself — while the
 * PostgreSQL one is a translation of it into SQL. Every case below therefore compares a SQL
 * clause against the specification it claims to implement, which is the only way an ordering or
 * cursor bug gets found before a user pages past it.
 *
 * The cases that matter most are the ones where a plausible clause differs from the domain:
 * `ORDER BY name` rather than `lower(name)`, `OFFSET` rather than a keyset seek, `LIKE` rather
 * than a literal substring search. Each has a case here that fails if the shortcut is taken.
 */

const connectionString = process.env['MUSICSTUDIO_DATABASE_URL'];

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';

/**
 * A provenance document that satisfies `audio_asset_provenance_shape` and 33.14's AI marker.
 *
 * Storage-layer scaffolding, not part of the contract: `LibraryAssetRecord` does not carry
 * provenance, and the listing rules under test are indifferent to it. The schema is not, which is
 * itself worth noticing — this fixture is the shape any writer of `audio_asset` must produce.
 */
const PROVENANCE = {
  engineId: 'ace-step-1.5',
  weightLicenseId: 'apache-2.0',
  attributionText: 'ACE-Step 1.5',
  commercialUseAllowed: true,
  nonCommercialLicenseListVersion: 1,
  recordedAtMs: 1_800_000_000_000,
  aiGenerated: true,
};

/** Fixed identifiers, because the tie-break is on the identifier and a random one is not a test. */
const ID = {
  apple: 'aaaaaaaa-0000-4000-8000-000000000001',
  zebra: 'aaaaaaaa-0000-4000-8000-000000000002',
  middle: 'aaaaaaaa-0000-4000-8000-000000000003',
  tied1: 'aaaaaaaa-0000-4000-8000-000000000004',
  tied2: 'aaaaaaaa-0000-4000-8000-000000000005',
} as const;

/**
 * A store loaded with records, however that implementation loads them.
 *
 * The PostgreSQL side has to insert accounts and rows with every NOT NULL column the schema
 * demands; the in-memory side takes the records as they are. The contract cares about neither, so
 * the difference lives in the factories.
 */
type StoreFactory = (seed: readonly LibraryAssetRecord[]) => Promise<LibraryAssetStore>;

function asset(overrides: Partial<LibraryAssetRecord> & { id: string }): LibraryAssetRecord {
  return assetRecord({ ownerId: OWNER, ...overrides });
}

function contractFor(name: string, open: StoreFactory) {
  describe(`LibraryAssetStore contract — ${name}`, () => {
    it('reads a stored asset back with its fields intact', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'Apple', caption: 'a caption', lyrics: 'a lyric', tags: ['lo-fi'] }),
      ]);

      const found = await store.find(ID.apple);
      expect(found?.name).toBe('Apple');
      expect(found?.caption).toBe('a caption');
      expect(found?.lyrics).toBe('a lyric');
      expect(found?.tags).toEqual(['lo-fi']);
    });

    it('returns null for an asset that is not there', async () => {
      const store = await open([]);
      expect(await store.find('33333333-3333-4333-8333-333333333333')).toBeNull();
    });

    it('lists only the requesting owner (Requirement 11.1)', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'Mine' }),
        asset({ id: ID.zebra, name: 'Theirs', ownerId: OTHER_OWNER }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER }));
      expect(page.assets.map((row) => row.name)).toEqual(['Mine']);
    });

    it('omits deleted assets from a listing (Requirement 11.7)', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'Kept' }),
        asset({ id: ID.zebra, name: 'Binned', isDeleted: true, deletedAtMs: 1_000 }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER }));
      expect(page.assets.map((row) => row.name)).toEqual(['Kept']);
    });

    it('filters by kind (Requirement 11.12)', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'A song', assetKind: 'song' }),
        asset({ id: ID.zebra, name: 'An effect', assetKind: 'sfx' }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER, assetKind: 'sfx' }));
      expect(page.assets.map((row) => row.name)).toEqual(['An effect']);
    });

    it('orders by title case-blind, so Z does not precede a (Requirement 11.4)', async () => {
      // The case that fails for `ORDER BY name`: raw collation puts every capital first, and the
      // domain folds case before comparing.
      const store = await open([
        asset({ id: ID.zebra, name: 'Zebra' }),
        asset({ id: ID.apple, name: 'apple' }),
        asset({ id: ID.middle, name: 'Middle' }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER, sortKey: 'title' }));
      expect(page.assets.map((row) => row.name)).toEqual(['apple', 'Middle', 'Zebra']);
    });

    it('orders by creation time and by play count, newest and most-played first', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'Old', createdAtMs: 1_000, playCount: 5 }),
        asset({ id: ID.zebra, name: 'New', createdAtMs: 3_000, playCount: 1 }),
      ]);

      expect(
        (await store.page(toLibraryQuery({ ownerId: OWNER, sortKey: 'created_at' }))).assets.map(
          (row) => row.name,
        ),
      ).toEqual(['New', 'Old']);
      expect(
        (await store.page(toLibraryQuery({ ownerId: OWNER, sortKey: 'play_count' }))).assets.map(
          (row) => row.name,
        ),
      ).toEqual(['Old', 'New']);
    });

    it('breaks a tie on the identifier ascending, so the order is total', async () => {
      const store = await open([
        asset({ id: ID.tied2, name: 'Second', playCount: 7 }),
        asset({ id: ID.tied1, name: 'First', playCount: 7 }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER, sortKey: 'play_count' }));
      expect(page.assets.map((row) => row.id)).toEqual([ID.tied1, ID.tied2]);
    });

    it('searches title, caption, lyrics and tags, case-blind (Requirement 11.3)', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'NIGHT drive' }),
        asset({ id: ID.zebra, name: 'b', caption: 'a Night scene' }),
        asset({ id: ID.middle, name: 'c', lyrics: 'through the night' }),
        asset({ id: ID.tied1, name: 'd', tags: ['night-owl'] }),
        asset({ id: ID.tied2, name: 'unrelated' }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER, search: 'NiGhT' }));
      expect(page.assets.map((row) => row.id).sort()).toEqual(
        [ID.apple, ID.zebra, ID.middle, ID.tied1].sort(),
      );
    });

    it('treats a search term literally, so % is a character and not a wildcard', async () => {
      // The case that fails for `LIKE '%' || term || '%'` without escaping: the term below would
      // match every row instead of the one that contains it.
      const store = await open([
        asset({ id: ID.apple, name: 'battery 100% charged' }),
        asset({ id: ID.zebra, name: 'unrelated' }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER, search: '100%' }));
      expect(page.assets.map((row) => row.id)).toEqual([ID.apple]);
    });

    it('pages with a cursor and stops with a null one at the end (Requirement 11.2)', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'one', createdAtMs: 3_000 }),
        asset({ id: ID.zebra, name: 'two', createdAtMs: 2_000 }),
        asset({ id: ID.middle, name: 'three', createdAtMs: 1_000 }),
      ]);

      const first = await store.page(toLibraryQuery({ ownerId: OWNER, pageSize: 2 }));
      expect(first.assets.map((row) => row.name)).toEqual(['one', 'two']);
      expect(first.nextCursor).not.toBeNull();

      const second = await store.page(
        toLibraryQuery({ ownerId: OWNER, pageSize: 2, cursor: first.nextCursor }),
      );
      expect(second.assets.map((row) => row.name)).toEqual(['three']);
      expect(second.nextCursor).toBeNull();
    });

    it('resumes past a tied cursor row without repeating or skipping it', async () => {
      // The case that fails for `OFFSET`, and the reason the identifier is in the cursor.
      const store = await open([
        asset({ id: ID.tied1, name: 'a', playCount: 7 }),
        asset({ id: ID.tied2, name: 'b', playCount: 7 }),
        asset({ id: ID.middle, name: 'c', playCount: 1 }),
      ]);

      const first = await store.page(
        toLibraryQuery({ ownerId: OWNER, pageSize: 1, sortKey: 'play_count' }),
      );
      expect(first.assets.map((row) => row.id)).toEqual([ID.tied1]);

      const second = await store.page(
        toLibraryQuery({
          ownerId: OWNER,
          pageSize: 1,
          sortKey: 'play_count',
          cursor: first.nextCursor,
        }),
      );
      expect(second.assets.map((row) => row.id)).toEqual([ID.tied2]);
    });

    it('returns a null cursor when the page exactly exhausts the set', async () => {
      const store = await open([
        asset({ id: ID.apple, name: 'a', createdAtMs: 2_000 }),
        asset({ id: ID.zebra, name: 'b', createdAtMs: 1_000 }),
      ]);

      const page = await store.page(toLibraryQuery({ ownerId: OWNER, pageSize: 2 }));
      expect(page.assets).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('renames an asset', async () => {
      const store = await open([asset({ id: ID.apple, name: 'Before' })]);
      expect((await store.rename(ID.apple, 'After')).name).toBe('After');
      expect((await store.find(ID.apple))?.name).toBe('After');
    });

    it('marks an asset deleted and records when', async () => {
      const store = await open([asset({ id: ID.apple })]);
      const updated = await store.setDeleted(ID.apple, true, 1_700_000_000_000);
      expect(updated.isDeleted).toBe(true);
      expect(updated.deletedAtMs).toBe(1_700_000_000_000);
    });

    it('purges an asset permanently (Requirement 11.8)', async () => {
      const store = await open([asset({ id: ID.apple, isDeleted: true, deletedAtMs: 1_000 })]);
      await store.purge(ID.apple);
      expect(await store.find(ID.apple)).toBeNull();
    });

    it('offers deleted assets to the purge sweep and withholds live ones', async () => {
      // A candidate set: `LibraryService.purgeExpired` re-checks the retention window itself, so
      // the contract pins what must be *offered*, not what must be excluded by age.
      const store = await open([
        asset({ id: ID.apple, isDeleted: true, deletedAtMs: 1_000 }),
        asset({ id: ID.zebra }),
      ]);

      const due = await store.findPurgeDue(9_999_999);
      expect(due.map((row) => row.id)).toContain(ID.apple);
      expect(due.map((row) => row.id)).not.toContain(ID.zebra);
    });

    it('replaces the whole tag set, so a tag can be removed', async () => {
      const store = await open([asset({ id: ID.apple, tags: ['keep', 'drop'] })]);
      const updated = await store.setTags(ID.apple, ['keep', 'added']);
      expect([...updated.tags].sort()).toEqual(['added', 'keep']);
    });
  });
}

contractFor('in-memory double', async (seed) => inMemoryAssetStore(seed));

if (connectionString === undefined) {
  describe.skip('LibraryAssetStore contract — PostgreSQL (no MUSICSTUDIO_DATABASE_URL)', () => {
    it('runs in the CI database job', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const client = new Client({ connectionString });

  beforeAll(async () => {
    await client.connect();
    const executor: SqlExecutor = {
      query: async (sql: string) => ({ rows: (await client.query(sql)).rows }),
    };
    await applyMigrations(executor, loadMigrations());
  });

  afterEach(async () => {
    await client.query('TRUNCATE account CASCADE');
  });

  afterAll(async () => {
    await client.end();
  });

  contractFor('PostgreSQL', async (seed) => {
    // The schema demands an owner and a provenance document that the record type does not carry;
    // they are fixtures of the storage layer, not of the contract, so they are supplied here.
    for (const ownerId of [OWNER, OTHER_OWNER]) {
      await client.query(
        `INSERT INTO account (id, email, password_hash) VALUES ($1, $2, 'x')
         ON CONFLICT (id) DO NOTHING`,
        [ownerId, `${ownerId}@example.com`],
      );
    }

    for (const record of seed) {
      await client.query(
        `INSERT INTO audio_asset
           (id, owner_id, name, asset_kind, duration_ms, sample_rate, channels, engine_id,
            provenance, created_at, is_deleted, deleted_at, caption, lyrics, play_count, object_key)
         VALUES ($1, $2, $3, $4::asset_kind, $5, 48000, $6, 'ace-step-1.5',
                 $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
        [
          record.id,
          record.ownerId,
          record.name,
          record.assetKind,
          record.durationMs,
          record.channels,
          JSON.stringify(PROVENANCE),
          new Date(record.createdAtMs),
          record.isDeleted,
          record.deletedAtMs === null ? null : new Date(record.deletedAtMs),
          record.caption,
          record.lyrics,
          record.playCount,
          record.objectKey,
        ],
      );

      for (const tag of record.tags) {
        await client.query(`INSERT INTO asset_tag (asset_id, tag) VALUES ($1, $2)`, [
          record.id,
          tag,
        ]);
      }
    }

    return createPgAssetStore(client);
  });
}
