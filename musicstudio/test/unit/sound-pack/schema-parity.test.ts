import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../../db/runner';
import {
  PACK_CUE_COUNT,
  PACK_DESCRIPTION_MAX_LENGTH,
  PACK_DESCRIPTION_MIN_LENGTH,
  PACK_NAME_MAX_LENGTH,
  PACK_NAME_MIN_LENGTH,
} from '../../../domain/sound-pack/bounds';
import { SOUND_PACK_STATUSES } from '../../../domain/sound-pack/status';

/**
 * Parity guard between migration `0014` and the rules in `domain/sound-pack/`.
 *
 * No database is reachable here — the same arrangement `0012` and `0013` use — so the check is
 * that the two declarations of the same numbers agree, which is what a drift would break.
 *
 * The migration set is verified by **presence and uniqueness plus the gap-free rule**, never by
 * "the latest migration is 0014". Task 3.2 had to remove exactly that assertion: it fails on
 * every future task for a reason that has nothing to do with the task, which trains people to
 * edit the test rather than read it.
 */

const migrations = loadMigrations();
const byId = new Map(migrations.map((migration) => [migration.id, migration.sql]));

function sqlOf(id: string): string {
  const sql = byId.get(id);
  if (sql === undefined) throw new Error(`missing migration ${id}`);
  return sql;
}

function enumMembers(sql: string, typeName: string): string[] {
  const pattern = new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`, 'i');
  const body = pattern.exec(sql)?.[1];
  if (body === undefined) throw new Error(`no enum ${typeName} found`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

describe('the migration set still holds together', () => {
  it('numbers every migration uniquely, with no gaps', () => {
    const sequences = migrations.map((migration) => Number(migration.id.slice(0, 4)));

    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((left, right) => left - right)).toEqual(
      Array.from({ length: migrations.length }, (_unused, index) => index + 1),
    );
  });

  it('includes the sound-pack migration', () => {
    // Presence, not position: this stays true when 0015 arrives.
    expect(byId.has('0014_sound_pack')).toBe(true);
  });
});

describe('sound_pack parity (design §4.1, Requirements 24.1, 24.2, 24.18)', () => {
  const sql = sqlOf('0014_sound_pack');

  it('creates the two tables design §4.1\'s SoundPack relationship needs', () => {
    expect(sql).toContain('CREATE TABLE sound_pack (');
    expect(sql).toContain('CREATE TABLE sound_pack_cue (');
  });

  it('uses the same status vocabulary as domain/sound-pack/status.ts, in order', () => {
    expect(enumMembers(sql, 'sound_pack_status')).toEqual([...SOUND_PACK_STATUSES]);
  });

  it('uses the same name and description bounds as domain/sound-pack/bounds.ts', () => {
    expect(sql).toContain(
      `char_length(name) BETWEEN ${String(PACK_NAME_MIN_LENGTH)} AND ${String(PACK_NAME_MAX_LENGTH)}`,
    );
    expect(sql).toContain(
      `char_length(personality_desc) BETWEEN ${String(PACK_DESCRIPTION_MIN_LENGTH)} AND ${String(PACK_DESCRIPTION_MAX_LENGTH)}`,
    );
  });

  it('uses the same cue count as the taxonomy, for the ceiling and for completeness', () => {
    expect(sql).toContain(`cue_count BETWEEN 0 AND ${String(PACK_CUE_COUNT)}`);
    expect(sql).toContain(`status <> 'complete' OR cue_count = ${String(PACK_CUE_COUNT)}`);
    expect(sql).toContain(`count(c.cue_name) = ${String(PACK_CUE_COUNT)} AS holds_every_cue`);
  });

  it('keys a cue row by (pack, cue), so Requirement 24.17 is an upsert', () => {
    expect(sql).toContain('PRIMARY KEY (pack_id, cue_name)');
  });

  it('enforces Requirement 24.18\'s asset kind rather than assuming it', () => {
    expect(sql).toContain('CREATE TRIGGER sound_pack_cue_require_sfx_asset');
    expect(sql).toContain("IF v_kind <> 'sfx' THEN");
    // The SQLSTATE convention the other migrations follow: MS + the requirement number.
    expect(sql).toContain("ERRCODE = 'MS024'");
  });

  it('does not declare the taxonomy a second time', () => {
    // A `semantic_cue` table or a 78-member enum would be a second declaration of
    // `domain/sound-pack/taxonomy.ts` that nothing could compare against. See the migration header.
    expect(sql).not.toContain('CREATE TABLE semantic_cue');
    expect(sql).not.toContain('CREATE TYPE semantic_cue');
    expect(sql).not.toContain("'hover'");
  });

  it('exposes completeness as a query, since the count floor is not a constraint', () => {
    expect(sql).toContain('CREATE VIEW sound_pack_completeness');
  });
});
