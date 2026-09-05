/**
 * `LibraryAssetStore` over PostgreSQL (track B1).
 *
 * ### The listing is `applyLibraryQuery`, written in SQL
 *
 * `services/library/ports.ts` says the store takes a whole `LibraryQuery` rather than loose
 * filters, precisely so that a SQL implementation has *one* function to be equivalent to instead
 * of four fragments to keep in step. This file is that equivalence, and the contract test is what
 * holds it: every ordering, filter and cursor case runs against both implementations, so a clause
 * that reads plausibly and behaves differently fails rather than ships.
 *
 * Three places where matching the domain took more than the obvious clause:
 *
 * - **Ordering.** `compareAssets` sorts `title` ascending on the *lower-cased* name and the other
 *   two descending, always breaking ties on the identifier ascending. `ORDER BY name` would order
 *   by the database's collation of the raw string, which puts `Zebra` before `apple`; the domain
 *   folds case first, so the SQL folds it too.
 * - **The cursor.** Keyset, not `OFFSET`: `seekPastCursor` resumes after a specific row, and an
 *   offset would skip or repeat rows when one is inserted between two pages. The comparison is on
 *   the pair `(sort value, id)`, which is why the identifier tie-break exists at all.
 * - **Exhaustion.** `applyLibraryQuery` returns a null cursor when the page reaches the end of the
 *   matching set. Asking for one row more than the page size answers that with the same query
 *   rather than a second `COUNT(*)` that could disagree with it under concurrent writes.
 *
 * ### `stemSourceAssetId` is read from `lineage`, not stored again
 *
 * Requirement 13.5's stems are `lineage` rows with `derivation_type = 'stem_split'`, and the
 * lineage table is where derivations live. A column on `audio_asset` would be a second answer to
 * "what was this split from", and the two would disagree the first time one was written without
 * the other.
 */

import { sortValue } from '../../../domain/library/query';
import type { LibraryPage, LibraryQuery } from '../../../domain/library/query';
import type { LibrarySortKey } from '../../../domain/library/bounds';
import type { AssetKind } from '../../../domain/asset-kind';
import type { LibraryAssetRecord, LibraryAssetStore } from '../ports';

/** The slice of `pg` this adapter uses; see `pg-account-repository.ts` on why it is structural. */
export interface PgQueryable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

interface AssetRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly asset_kind: AssetKind;
  readonly caption: string;
  readonly lyrics: string;
  readonly play_count: string | number;
  readonly created_at: Date;
  readonly is_deleted: boolean;
  readonly deleted_at: Date | null;
  readonly object_key: string | null;
  readonly sample_rate: number;
  readonly channels: number;
  readonly duration_ms: number;
  readonly tags: readonly string[] | null;
  readonly stem_source_asset_id: string | null;
}

/**
 * Every column the record needs, including the two that are not columns.
 *
 * `tags` and `stem_source_asset_id` are correlated subqueries rather than joins: a join to
 * `asset_tag` multiplies the asset row by its tags, and the `LIMIT` in the listing would then
 * count tag rows instead of assets — a page of ten would return four assets and look like a
 * pagination bug rather than a join bug.
 */
const SELECT_COLUMNS = `
  a.id, a.owner_id, a.name, a.asset_kind, a.caption, a.lyrics, a.play_count,
  a.created_at, a.is_deleted, a.deleted_at, a.object_key, a.sample_rate, a.channels,
  a.duration_ms,
  (SELECT coalesce(array_agg(t.tag ORDER BY t.created_at, t.tag), ARRAY[]::text[])
     FROM asset_tag t WHERE t.asset_id = a.id) AS tags,
  (SELECT l.parent_asset_id FROM lineage l
    WHERE l.child_asset_id = a.id AND l.derivation_type = 'stem_split'
    LIMIT 1) AS stem_source_asset_id`;

function toRecord(row: AssetRow): LibraryAssetRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    assetKind: row.asset_kind,
    caption: row.caption,
    lyrics: row.lyrics,
    // `bigint` arrives as a string from `pg` — the driver will not silently narrow a value that
    // may exceed `Number.MAX_SAFE_INTEGER`. A play count never will, so the conversion is safe
    // here and stated rather than left as an implicit coercion elsewhere.
    playCount: Number(row.play_count),
    createdAtMs: row.created_at.getTime(),
    isDeleted: row.is_deleted,
    tags: row.tags ?? [],
    objectKey: row.object_key,
    deletedAtMs: row.deleted_at === null ? null : row.deleted_at.getTime(),
    sampleRate: row.sample_rate,
    channels: row.channels,
    durationMs: row.duration_ms,
    stemSourceAssetId: row.stem_source_asset_id,
  };
}

/** The SQL expression `sortValue` returns for a row, under a given order. */
function sortExpression(sortKey: LibrarySortKey): string {
  switch (sortKey) {
    // Folded, because `compareAssets` compares `name.toLowerCase()`. Comparing the raw column
    // would order by collation and disagree with the domain on any mixed-case library.
    case 'title':
      return 'lower(a.name)';
    case 'play_count':
      return 'a.play_count';
    case 'created_at':
      return 'a.created_at';
  }
}

/** `title` ascends; the other two descend. See `compareAssets`. */
function isAscending(sortKey: LibrarySortKey): boolean {
  return sortKey === 'title';
}

/** A cursor value as the column holds it. */
function cursorValue(sortKey: LibrarySortKey, value: string | number): unknown {
  return sortKey === 'created_at' ? new Date(Number(value)) : value;
}

export function createPgAssetStore(db: PgQueryable): LibraryAssetStore {
  async function findRow(assetId: string): Promise<LibraryAssetRecord | null> {
    const { rows } = await db.query<AssetRow>(
      `SELECT ${SELECT_COLUMNS} FROM audio_asset a WHERE a.id = $1`,
      [assetId],
    );
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async function requireRow(assetId: string): Promise<LibraryAssetRecord> {
    const record = await findRow(assetId);
    if (record === null) throw new Error(`no such asset: ${assetId}`);
    return record;
  }

  return {
    find: findRow,

    async page(query: LibraryQuery): Promise<LibraryPage> {
      const values: unknown[] = [query.ownerId];
      // Requirements 11.1 and 11.7 — owner scope and the deletion filter, applied here so no
      // listing path can omit them, exactly as `applyLibraryQuery` applies them for the double.
      const where = ['a.owner_id = $1', 'a.is_deleted = false'];

      if (query.assetKind !== null) {
        values.push(query.assetKind);
        where.push(`a.asset_kind = $${String(values.length)}`);
      }

      if (query.search !== null) {
        // Requirement 11.3: title, caption, lyrics or a tag, substring and case-blind. The term
        // arrives already normalised by `toLibraryQuery`; the stored tag is normalised too, which
        // is why the tag arm needs no `lower()`. `position(... in ...)` rather than `LIKE`, so a
        // term containing `%` or `_` searches for those characters instead of behaving as a
        // wildcard — a user searching "100%" should not match everything.
        values.push(query.search);
        const term = `$${String(values.length)}`;
        where.push(`(
          position(${term} in lower(a.name)) > 0
          OR position(${term} in lower(a.caption)) > 0
          OR position(${term} in lower(a.lyrics)) > 0
          OR EXISTS (SELECT 1 FROM asset_tag t
                      WHERE t.asset_id = a.id AND position(${term} in t.tag) > 0)
        )`);
      }

      const expression = sortExpression(query.sortKey);
      const ascending = isAscending(query.sortKey);

      if (query.cursor !== null) {
        values.push(cursorValue(query.sortKey, query.cursor.value));
        const valueParam = `$${String(values.length)}`;
        values.push(query.cursor.id);
        const idParam = `$${String(values.length)}`;

        // Keyset: strictly past the cursor row in the total order `compareAssets` defines.
        //
        // The tempting form is a row comparison — `(value, id) < ($1, $2)` — and it is correct
        // only when both columns run the same way. `created_at` and `play_count` descend while
        // the identifier always ascends, and a row comparison has no way to say that: it read
        // the tie-break as descending too, so paging past two assets with the same play count
        // returned the *first* of them again instead of the second. The contract's tied-cursor
        // case is what caught it.
        where.push(
          ascending
            ? `(${expression}, a.id) > (${valueParam}, ${idParam})`
            : `(${expression} < ${valueParam}
                OR (${expression} = ${valueParam} AND a.id > ${idParam}))`,
        );
      }

      // One more than the page: its presence is the answer to "is there a next page", without a
      // second query that could see a different set.
      values.push(query.pageSize + 1);
      const limitParam = `$${String(values.length)}`;
      const direction = ascending ? 'ASC' : 'DESC';

      const { rows } = await db.query<AssetRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audio_asset a
          WHERE ${where.join(' AND ')}
          ORDER BY ${expression} ${direction}, a.id ASC
          LIMIT ${limitParam}`,
        values,
      );

      const hasMore = rows.length > query.pageSize;
      const assets = rows.slice(0, query.pageSize).map(toRecord);
      const last = assets.at(-1);

      return {
        assets,
        nextCursor:
          !hasMore || last === undefined
            ? null
            : // `sortValue` from the domain rather than the same switch written again here. The
              // cursor this returns is the one the next call compares against, so a second
              // implementation of it would be two answers to one question — and the disagreement
              // would show up as a page that skips rows, which is the hardest kind to notice.
              { sortKey: query.sortKey, value: sortValue(last, query.sortKey), id: last.id },
      };
    },

    async rename(assetId, name) {
      await db.query(`UPDATE audio_asset SET name = $2 WHERE id = $1`, [assetId, name]);
      return requireRow(assetId);
    },

    async setDeleted(assetId, isDeleted, atMs) {
      await db.query(`UPDATE audio_asset SET is_deleted = $2, deleted_at = $3 WHERE id = $1`, [
        assetId,
        isDeleted,
        atMs === null ? null : new Date(atMs),
      ]);
      return requireRow(assetId);
    },

    async purge(assetId) {
      // The row and its audio, both gone (Requirement 11.8). `asset_tag` and `lineage` rows
      // referencing it as a child cascade; a `lineage` row referencing it as a *parent* does not,
      // and that restriction is deliberate upstream — a purge that orphaned a derived asset's
      // ancestry would erase the provenance the derived asset still needs.
      await db.query(`DELETE FROM audio_asset WHERE id = $1`, [assetId]);
    },

    async findPurgeDue(nowMs) {
      // A candidate set, not a verdict: `LibraryService.purgeExpired` re-checks each row with
      // `isPurgeDue`, which owns the retention window. Narrowing here to rows that are deleted and
      // whose timestamp has passed keeps the sweep from reading the whole library, while leaving
      // the rule itself in the domain where both implementations read it.
      const { rows } = await db.query<AssetRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audio_asset a
          WHERE a.is_deleted = true AND (a.deleted_at IS NULL OR a.deleted_at <= $1)
          ORDER BY a.id ASC`,
        [new Date(nowMs)],
      );
      return rows.map(toRecord);
    },

    async setTags(assetId, tags) {
      // Replace rather than merge: the port's `setTags` states the whole set, and a merge would
      // make removing a tag impossible through this method.
      await db.query(`DELETE FROM asset_tag WHERE asset_id = $1`, [assetId]);
      for (const tag of tags) {
        await db.query(`INSERT INTO asset_tag (asset_id, tag) VALUES ($1, $2)`, [assetId, tag]);
      }
      return requireRow(assetId);
    },

    async listSoundPackAssets(packId) {
      // Requirement 11.13, cue name ascending — the order the pack is read in, not the order the
      // cues were generated in.
      const { rows } = await db.query<AssetRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audio_asset a
           JOIN sound_pack_cue c ON c.asset_id = a.id
          WHERE c.pack_id = $1
          ORDER BY c.cue_name ASC`,
        [packId],
      );
      return rows.map(toRecord);
    },

    async listStemsOf(sourceAssetId) {
      const { rows } = await db.query<AssetRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audio_asset a
           JOIN lineage l ON l.child_asset_id = a.id
          WHERE l.parent_asset_id = $1 AND l.derivation_type = 'stem_split'
          ORDER BY a.id ASC`,
        [sourceAssetId],
      );
      return rows.map(toRecord);
    },
  };
}
