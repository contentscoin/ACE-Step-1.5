import pg from 'pg';

import { applyMigrations, loadMigrations, type SqlExecutor } from '../../db/runner';

/**
 * Applies every pending migration over one `pg` connection.
 *
 * `db/runner.ts` is deliberately driver-agnostic and takes an `SqlExecutor`; this is the one
 * place that gives it a real client. Used by `scripts/migrate.ts` and, when
 * `MUSICSTUDIO_MIGRATE_ON_START` is set, by the bootstrap — the same function either way, so
 * the two cannot apply the schema differently.
 */
export async function applyPendingMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const executor: SqlExecutor = {
      query: async (sql: string) => ({ rows: (await client.query(sql)).rows }),
    };
    return await applyMigrations(executor, loadMigrations());
  } finally {
    await client.end();
  }
}
