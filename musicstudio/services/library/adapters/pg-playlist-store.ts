/**
 * `PlaylistStore` over PostgreSQL (roadmap §4.4, slice S6).
 *
 * ### This adapter takes a pool, not a queryable, and the reason is `playlist_item`
 *
 * Every other pg adapter here needs only `query`, so it takes the structural `PgQueryable` and
 * the composition root hands it the pool. A playlist is two tables — the row and its ordered
 * items — and writing one without the other is a visible wrong state: a playlist that exists
 * and is empty, or items belonging to a playlist that does not. Separate `query` calls on a
 * pool may land on different connections, so they cannot be one transaction. This takes the
 * pool's `connect` instead and does its writes on one session inside `BEGIN`/`COMMIT`.
 *
 * ### The order is the `position` column, and the primary key enforces it
 *
 * `0016_library.sql` makes `(playlist_id, position)` the primary key precisely so Requirement
 * 11.10's "순서를 보존한" is a property of the table. Reads therefore `ORDER BY position` and
 * writes number from zero in the order given; nothing sorts a playlist anywhere else.
 *
 * ### A reorder deletes and rewrites
 *
 * The item set is replaced rather than diffed. `playlist_item_unique_asset` means a diff would
 * have to sequence its updates to avoid colliding with rows it is about to move, and inside one
 * transaction the delete-then-insert is both simpler and indistinguishable from outside.
 */

import type { PlaylistRecord, PlaylistStore } from '../ports';

interface QueryResult<Row> {
  readonly rows: Row[];
}

interface PgSession {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}

/** The slice of `pg.Pool` this adapter uses. Structural, like every other adapter's. */
export interface PgTransactor {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  connect(): Promise<PgSession>;
}

interface PlaylistRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly asset_ids: readonly string[] | null;
}

/**
 * The items as an ordered array, gathered in a subquery.
 *
 * A join would multiply the playlist row by its items, which `listByOwner` would then have to
 * fold back together — the same trap `pg-asset-store.ts` avoids for tags.
 */
const SELECT_COLUMNS = `
  p.id, p.owner_id, p.name, p.created_at, p.updated_at,
  (SELECT coalesce(array_agg(i.asset_id ORDER BY i.position), ARRAY[]::uuid[])
     FROM playlist_item i WHERE i.playlist_id = p.id) AS asset_ids`;

function toRecord(row: PlaylistRow): PlaylistRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    assetIds: row.asset_ids ?? [],
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

/** `unnest(... ) WITH ORDINALITY` numbers the items from zero, in the order given. */
const INSERT_ITEMS = `
  INSERT INTO playlist_item (playlist_id, asset_id, position)
  SELECT $1, entry.asset_id, entry.ordinality - 1
    FROM unnest($2::uuid[]) WITH ORDINALITY AS entry(asset_id, ordinality)`;

export function createPgPlaylistStore(db: PgTransactor): PlaylistStore {
  /** Runs `work` inside one transaction on one connection, releasing it either way. */
  async function inTransaction(work: (session: PgSession) => Promise<void>): Promise<void> {
    const session = await db.connect();
    try {
      await session.query('BEGIN');
      await work(session);
      await session.query('COMMIT');
    } catch (error) {
      // A rollback that itself fails must not replace the error that caused it — that one
      // says what went wrong, and this one only says the connection is already broken.
      await session.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      session.release();
    }
  }

  return {
    async insert(record) {
      await inTransaction(async (session) => {
        await session.query(
          `INSERT INTO playlist (id, owner_id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [record.id, record.ownerId, record.name, new Date(record.createdAtMs)],
        );
        await session.query(INSERT_ITEMS, [record.id, [...record.assetIds]]);
      });
    },

    async find(playlistId) {
      const { rows } = await db.query<PlaylistRow>(
        `SELECT ${SELECT_COLUMNS} FROM playlist p WHERE p.id = $1`,
        [playlistId],
      );
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async update(record) {
      await inTransaction(async (session) => {
        await session.query(`UPDATE playlist SET name = $2, updated_at = $3 WHERE id = $1`, [
          record.id,
          record.name,
          new Date(record.updatedAtMs),
        ]);
        await session.query(`DELETE FROM playlist_item WHERE playlist_id = $1`, [record.id]);
        await session.query(INSERT_ITEMS, [record.id, [...record.assetIds]]);
      });
    },

    async remove(playlistId) {
      // `playlist_item` cascades on the foreign key, so the items go with the row.
      await db.query(`DELETE FROM playlist WHERE id = $1`, [playlistId]);
    },

    async listByOwner(ownerId) {
      const { rows } = await db.query<PlaylistRow>(
        `SELECT ${SELECT_COLUMNS} FROM playlist p
          WHERE p.owner_id = $1
          ORDER BY p.created_at DESC, p.id`,
        [ownerId],
      );
      return rows.map(toRecord);
    },
  };
}
