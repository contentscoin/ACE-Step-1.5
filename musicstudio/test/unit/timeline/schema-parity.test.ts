import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../../db/runner';
import {
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  PROJECT_CLIP_COUNT_MAX,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_DESCRIPTION_MIN_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  TEMPO_BPM_MAX,
  TEMPO_BPM_MIN,
  TIME_SIGNATURES,
  TRACK_INDEX_MAX,
  TRACK_INDEX_MIN,
  TRACK_PAN_MAX,
  TRACK_PAN_MIN,
  TRACK_VOLUME_DB_MAX,
  TRACK_VOLUME_DB_MIN,
} from '../../../domain/timeline/bounds';

/**
 * Parity guard between migration `0015` and the rules in `domain/timeline/`.
 *
 * No database is reachable here — the same arrangement `0012`, `0013` and `0014` use — so the check
 * is that the two declarations of the same numbers agree, which is what a drift would break.
 *
 * The migration set is verified by **presence and uniqueness plus the gap-free rule**, never by
 * "the latest migration is 0015". Task 3.2 had to remove exactly that assertion: it fails on every
 * future task for a reason that has nothing to do with the task, which trains people to edit the
 * test rather than read it.
 */

const migrations = loadMigrations();
const byId = new Map(migrations.map((migration) => [migration.id, migration.sql]));

function sqlOf(id: string): string {
  const sql = byId.get(id);
  if (sql === undefined) throw new Error(`missing migration ${id}`);
  return sql;
}

/**
 * The migration with its `--` comments stripped.
 *
 * The negative assertions below say things like "no snap column", and 0015's header *explains* why
 * there is no snap column — so a search over the raw text would find the explanation and fail. The
 * headers in this schema are long and load-bearing, so the fix is to look at the DDL rather than to
 * write shorter comments.
 */
function ddlOf(id: string): string {
  return sqlOf(id)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('the migration set still holds together', () => {
  it('numbers every migration uniquely, with no gaps', () => {
    const sequences = migrations.map((migration) => Number(migration.id.slice(0, 4)));

    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((left, right) => left - right)).toEqual(
      Array.from({ length: migrations.length }, (_unused, index) => index + 1),
    );
  });

  it('includes the timeline migration', () => {
    // Presence, not position: this stays true when 0016 arrives.
    expect(byId.has('0015_timeline_project')).toBe(true);
  });
});

describe('timeline_project parity (design §4.1, Requirements 28.1, 28.39)', () => {
  const sql = sqlOf('0015_timeline_project');

  it('creates the three tables the project, its clips and its tracks need', () => {
    expect(sql).toContain('CREATE TABLE timeline_project (');
    expect(sql).toContain('CREATE TABLE timeline_clip (');
    expect(sql).toContain('CREATE TABLE timeline_track (');
  });

  it('uses the same name and description bounds as domain/timeline/bounds.ts', () => {
    expect(sql).toContain(
      `char_length(name) BETWEEN ${String(PROJECT_NAME_MIN_LENGTH)} AND ${String(PROJECT_NAME_MAX_LENGTH)}`,
    );
    expect(sql).toContain(
      `char_length(description) BETWEEN ${String(PROJECT_DESCRIPTION_MIN_LENGTH)} AND ${String(PROJECT_DESCRIPTION_MAX_LENGTH)}`,
    );
  });

  it('uses the same tempo range and time signature set (Requirement 28.39)', () => {
    expect(sql).toContain(
      `tempo_bpm BETWEEN ${String(TEMPO_BPM_MIN)} AND ${String(TEMPO_BPM_MAX)}`,
    );
    expect(sql).toContain(`time_signature IN (${TIME_SIGNATURES.join(', ')})`);
    // Requirement 28.39 and 28.21 both legislate for a project with neither set.
    expect(sql).toContain('tempo_bpm IS NULL OR');
    expect(sql).toContain('time_signature IS NULL OR');
  });
});

describe('timeline_clip parity (Requirements 28.2–28.5, 28.7, 28.10, 28.13, 28.16, 28.17)', () => {
  const sql = sqlOf('0015_timeline_project');

  it('uses the same track range as domain/timeline/bounds.ts', () => {
    expect(sql).toContain(
      `track BETWEEN ${String(TRACK_INDEX_MIN)} AND ${String(TRACK_INDEX_MAX)}`,
    );
  });

  it('uses the same clip gain range', () => {
    expect(sql).toContain(
      `gain_db BETWEEN ${String(CLIP_GAIN_DB_MIN)} AND ${String(CLIP_GAIN_DB_MAX)}`,
    );
  });

  it('stores the clip list order, since Requirement 28.32 compares it', () => {
    expect(sql).toContain('position integer NOT NULL');
    expect(sql).toContain('UNIQUE (project_id, position)');
  });

  it('derives play length rather than storing it (Requirement 28.13)', () => {
    expect(sql).toContain(
      'play_length_ms integer GENERATED ALWAYS AS (source_duration_ms - trim_start_ms - trim_end_ms) STORED',
    );
  });

  it('enforces Requirement 28.10\'s strict trim inequality', () => {
    expect(sql).toContain('trim_start_ms + trim_end_ms < source_duration_ms');
  });

  it('enforces Requirement 28.17\'s fade ceiling in integers', () => {
    // Doubled rather than halved, so the comparison never leaves integer arithmetic.
    expect(sql).toContain('fade_in_ms * 2 <= source_duration_ms - trim_start_ms - trim_end_ms');
    expect(sql).toContain('fade_out_ms * 2 <= source_duration_ms - trim_start_ms - trim_end_ms');
  });

  it('enforces the clip ceiling and non-overlap in a trigger, since no CHECK can', () => {
    expect(sql).toContain('CREATE TRIGGER timeline_clip_bounds');
    expect(sql).toContain(`already holds % of ${String(PROJECT_CLIP_COUNT_MAX)} clips`);
    expect(sql).toContain('overlaps clip % on track % by % ms');
    // The SQLSTATE convention the other migrations follow: MS + the requirement number.
    expect(sql).toContain("ERRCODE = 'MS028'");
  });

  it('verifies the denormalised source duration against the asset', () => {
    expect(sql).toContain('NEW.source_duration_ms <> v_asset_duration');
  });

  it('installs no extension, so the overlap check needs nothing beyond core Postgres', () => {
    // An `EXCLUDE USING gist` constraint would be the better tool and would need `btree_gist`.
    const ddl = ddlOf('0015_timeline_project');
    expect(ddl).not.toContain('CREATE EXTENSION');
    expect(ddl).not.toContain('btree_gist');
  });
});

describe('timeline_track parity (Requirements 28.4, 28.18)', () => {
  const sql = sqlOf('0015_timeline_project');

  it('uses the same volume and pan ranges as domain/timeline/bounds.ts', () => {
    expect(sql).toContain(
      `volume_db BETWEEN ${String(TRACK_VOLUME_DB_MIN)} AND ${String(TRACK_VOLUME_DB_MAX)}`,
    );
    expect(sql).toContain(
      `pan BETWEEN ${TRACK_PAN_MIN.toFixed(1)} AND ${TRACK_PAN_MAX.toFixed(1)}`,
    );
  });

  it('keys a track row by (project, track)', () => {
    expect(sql).toContain('PRIMARY KEY (project_id, track)');
  });

  it('seeds all 32 tracks with the project, so Requirement 28.32 has something to compare', () => {
    expect(sql).toContain('CREATE TRIGGER timeline_project_seed_tracks');
    expect(sql).toContain(
      `generate_series(${String(TRACK_INDEX_MIN)}, ${String(TRACK_INDEX_MAX)})`,
    );
  });
});

describe('what migration 0015 deliberately does not store', () => {
  // The DDL, not the file: the header explains each of these absences, so a raw search would find
  // the explanation. See `ddlOf`.
  const ddl = ddlOf('0015_timeline_project');

  it('stores no undo history', () => {
    // Requirement 28.22's commands hold before/after values that only mean anything against the
    // exact project state they were planned on. See the migration header.
    expect(ddl).not.toContain('undo_history');
    expect(ddl).not.toContain('edit_command');
  });

  it('stores no mixdown reference', () => {
    // Requirement 28.24 stores the result as an Asset_Kind = 'mix' Audio_Asset, which 0003 models
    // and 0005's lineage links. Task 4.2's.
    expect(ddl).not.toContain('mixdown');
  });

  it('stores no snap setting', () => {
    // Requirement 28.21's snapping is a per-request flag, not project state. Matched as a column
    // declaration rather than as the bare word, because a `COMMENT ON COLUMN` legitimately mentions
    // snapping when explaining what a NULL tempo means for it.
    expect(ddl).not.toMatch(/^\s*snap\w*\s+\w+/mu);
    expect(ddl).not.toContain('snap_enabled');
  });

  it('exposes Requirement 28.36\'s read as a view', () => {
    expect(ddl).toContain('CREATE VIEW timeline_clip_availability');
  });
});
