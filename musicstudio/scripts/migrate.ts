/**
 * `npm run db:migrate` — apply pending migrations to `MUSICSTUDIO_DATABASE_URL`.
 *
 * Prints the ids it applied, or `up to date`. Exits non-zero on the first failing migration,
 * which `db/runner.ts` has already rolled back; the ledger then shows exactly where to resume.
 */

import { applyPendingMigrations } from '../api/gateway/database';

const connectionString = process.env['MUSICSTUDIO_DATABASE_URL'];
if (connectionString === undefined || connectionString.length === 0) {
  process.stderr.write('MUSICSTUDIO_DATABASE_URL is required.\n');
  process.exit(2);
}

try {
  const applied = await applyPendingMigrations(connectionString);
  process.stdout.write(
    applied.length === 0 ? 'up to date\n' : `applied ${String(applied.length)}:\n  ${applied.join('\n  ')}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
