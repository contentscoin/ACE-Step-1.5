/**
 * Migration runner for the product-layer schema (design §4, §1.4.5).
 *
 * Deliberately driver-agnostic: it needs only `query`, so `db/` gains no
 * database-client dependency and the same code drives a `pg` client in tests, a
 * pool in the API, or a psql wrapper in ops.
 *
 * Each migration runs inside its own transaction and is recorded in
 * `schema_migration`, so a failure leaves nothing half-applied and a re-run
 * resumes at the first unapplied file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface SqlExecutor {
  query(sql: string): Promise<QueryResult>;
}

export interface Migration {
  /** Filename without the extension, e.g. `0003_audio_asset`. */
  readonly id: string;
  readonly fileName: string;
  readonly sql: string;
}

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));

export const LEDGER_TABLE = 'schema_migration';

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);`;

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Load migrations in lexicographic filename order, which is their apply order. */
export function loadMigrations(directory: string = MIGRATIONS_DIRECTORY): Migration[] {
  const fileNames = readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));

  const sequences = new Set<string>();

  return fileNames.map((fileName) => {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new Error(
        `migration filename must match NNNN_snake_case.sql, found "${fileName}"`,
      );
    }
    const sequence = match[1] as string;
    if (sequences.has(sequence)) {
      throw new Error(`duplicate migration sequence ${sequence} ("${fileName}")`);
    }
    sequences.add(sequence);

    return {
      id: fileName.slice(0, -'.sql'.length),
      fileName,
      sql: readFileSync(join(directory, fileName), 'utf8'),
    };
  });
}

async function appliedMigrationIds(executor: SqlExecutor): Promise<Set<string>> {
  const result = await executor.query(`SELECT id FROM ${LEDGER_TABLE}`);
  return new Set(result.rows.map((row) => String(row['id'])));
}

/**
 * Apply every migration not yet recorded in the ledger. Returns the ids applied
 * by this call, so a caller can tell "already up to date" from "just migrated".
 */
export async function applyMigrations(
  executor: SqlExecutor,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<string[]> {
  await executor.query(LEDGER_DDL);
  const applied = await appliedMigrationIds(executor);
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    await executor.query('BEGIN');
    try {
      await executor.query(migration.sql);
      await executor.query(
        `INSERT INTO ${LEDGER_TABLE} (id) VALUES ('${migration.id}')`,
      );
      await executor.query('COMMIT');
    } catch (error) {
      await executor.query('ROLLBACK');
      throw new Error(`migration ${migration.fileName} failed: ${describe(error)}`, {
        cause: error,
      });
    }

    newlyApplied.push(migration.id);
  }

  return newlyApplied;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
