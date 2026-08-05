import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../../db/runner';
import { BUILT_IN_PRESET_IDS } from '../../../domain/effects/preset';
import {
  CHAIN_ITEM_COUNT_MAX,
  CHAIN_ITEM_COUNT_MIN,
  EFFECT_NAME_MAX_LENGTH,
  EFFECT_NAME_MIN_LENGTH,
  MAX_PRESETS_PER_USER,
} from '../../../domain/effects/registry';

/**
 * Parity guard between `0013_effect_preset.sql` and the rules in `domain/effects/`.
 *
 * **Validates: Requirements 29.11, 29.13, 29.21, 29.22, 29.23, 29.35**
 *
 * The migration is a thin wrapper: the name bound, the chain item count and the array shape
 * all exist in two places, and they are only "the same rules" for as long as something checks.
 * This suite is that check, and — like the parity suites of tasks 1.1, 2.7 and 6.2 — it needs
 * no database, so it runs in the fast loop rather than behind `MUSICSTUDIO_DATABASE_URL`.
 * Migrations have never been executed against a real database in this environment, which is
 * exactly why the schema is validated by parsing rather than by applying.
 */

const migrations = loadMigrations();
const migration = migrations.find((candidate) => candidate.id === '0013_effect_preset');

if (migration === undefined) throw new Error('missing migration 0013_effect_preset');

const sql: string = migration.sql;

describe('migration ordering', () => {
  it('keeps the migration sequence gap-free', () => {
    // The runner applies files in order and records them; a gap would mean a file that
    // never runs on a fresh database.
    const numbers = migrations.map((candidate) => Number(candidate.id.slice(0, 4)));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_unused, i) => i + 1));
  });

  it('places Effect_Preset at 0013, exactly once', () => {
    // Presence and uniqueness rather than "0013 is last": the next feature to add a
    // table would invalidate a "last" assertion, and the gap-free check above is
    // already the invariant that matters.
    expect(migrations.filter((candidate) => candidate.id === '0013_effect_preset')).toHaveLength(
      1,
    );
    expect(migrations.map((candidate) => candidate.id)).toContain('0013_effect_preset');
  });
});

describe('Requirement 29.22 — the name bound matches the domain', () => {
  it('CHECKs char_length between the domain\u2019s two bounds', () => {
    expect(sql).toContain(
      `CHECK (char_length(name) BETWEEN ${String(EFFECT_NAME_MIN_LENGTH)} AND ${String(EFFECT_NAME_MAX_LENGTH)})`,
    );
  });
});

describe('Requirements 29.11, 29.13 — the chain column', () => {
  it('requires the chain to be a JSON array', () => {
    expect(sql).toContain("jsonb_typeof(chain) = 'array'");
  });

  it('CHECKs the item count against the domain\u2019s bounds', () => {
    expect(sql).toContain(
      `jsonb_array_length(chain) BETWEEN ${String(CHAIN_ITEM_COUNT_MIN)} AND ${String(CHAIN_ITEM_COUNT_MAX)}`,
    );
  });

  it('requires every item to carry a kind and a parameters object', () => {
    // Expressed as a SQL/JSON path rather than a lateral subquery: PostgreSQL rejects a
    // subquery in a CHECK with `0A000`, so the earlier form could never have been applied.
    // See the migration's own comment, and `test/integration/db-schema.test.ts` for the
    // constraint exercised against a real server.
    expect(sql).toContain('NOT jsonb_path_exists(');
    expect(sql).toContain('!exists(@.kind) || @.kind.type() != "string"');
    expect(sql).toContain('!exists(@.parameters) || @.parameters.type() != "object"');
  });
});

describe('Requirements 29.21, 29.23 — built-ins are not rows', () => {
  it('makes owner_id NOT NULL, so every row is a user preset', () => {
    // This is what makes Requirement 29.35's COUNT(*) per owner exactly the right query,
    // with no `WHERE owner_id IS NOT NULL` anywhere.
    expect(sql).toMatch(/owner_id uuid NOT NULL REFERENCES account \(id\) ON DELETE CASCADE/);
  });

  it('records that built-ins live in the domain, not the table', () => {
    expect(sql).toContain('domain/effects/preset.ts');
  });

  it('uses the builtin_ prefix the domain ids use, so a row can never collide', () => {
    expect(BUILT_IN_PRESET_IDS.every((id) => id.startsWith('builtin_'))).toBe(true);
    expect(sql).toContain("id::text NOT LIKE 'builtin\\_%'");
  });
});

describe('Requirement 29.35 — the cap is documented, not CHECKed', () => {
  it('names the limit in the column comment', () => {
    // Postgres cannot express "at most N rows per owner" declaratively, and the decision
    // belongs to the service, which must return the count and the limit rather than raise.
    expect(sql).toContain(`at most ${String(MAX_PRESETS_PER_USER)} rows per owner`);
    expect(sql).toContain('services/effects/preset-service.ts');
  });
});

describe('indexes', () => {
  it('indexes the owner for the counting query and the list view', () => {
    expect(sql).toContain('CREATE INDEX effect_preset_owner_idx ON effect_preset (owner_id, created_at)');
  });

  it('prevents duplicate names within one owner', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX effect_preset_owner_name_unique ON effect_preset (owner_id, lower(name))',
    );
  });
});
