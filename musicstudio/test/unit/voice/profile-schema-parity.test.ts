import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../../db/runner';
import {
  REFERENCE_SAMPLE_COUNT_MAX,
  VOICE_PROFILE_NAME_MAX_LENGTH,
  VOICE_PROFILE_NAME_MIN_LENGTH,
  VOICE_PROFILE_TYPES,
} from '../../../domain/voice/profile';
import {
  REFERENCE_SAMPLE_DURATION_MS_MAX,
  REFERENCE_SAMPLE_DURATION_MS_MIN,
  REFERENCE_SAMPLE_FORMATS,
  REFERENCE_SAMPLE_SAMPLE_RATE_MIN,
} from '../../../domain/voice/reference-sample';
import { DEFAULT_PRESET_VOICE_CATALOGUE } from '../../../domain/voice/voice-catalogue';

/**
 * Parity guard between `0012_voice_profile.sql` and the rules in `domain/voice/`.
 *
 * **Validates: Requirements 26.1, 26.2, 26.3, 26.7, 26.8, 26.9, 26.10**
 *
 * The migration is a thin wrapper: the type vocabulary, the name bound, the sample bounds, the
 * format list and the 10-sample cap all exist in two languages, and they are only "the same rules"
 * for as long as something checks. This suite is that check, and — like the parity suites of tasks
 * 1.1 and 6.2 — it needs no database, so it runs in the fast loop rather than behind
 * `MUSICSTUDIO_DATABASE_URL`.
 */

const migrations = loadMigrations();
const migration = migrations.find((candidate) => candidate.id === '0012_voice_profile');

if (migration === undefined) throw new Error('missing migration 0012_voice_profile');

const sql: string = migration.sql;

function enumMembers(typeName: string): string[] {
  const pattern = new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`, 'i');
  const body = pattern.exec(sql)?.[1];
  if (body === undefined) throw new Error(`no enum ${typeName} found`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

describe('enum parity (Requirements 26.1, 26.3, 26.9)', () => {
  it('voice_profile_type matches the domain list, in order', () => {
    expect(enumMembers('voice_profile_type')).toEqual([...VOICE_PROFILE_TYPES]);
  });

  it('reference_sample_format matches Requirement 26.3\u2019s three formats', () => {
    expect(enumMembers('reference_sample_format')).toEqual([...REFERENCE_SAMPLE_FORMATS]);
  });
});

describe('it extends task 6.2\u2019s row rather than creating a second one', () => {
  it('alters `voice_profile` and never re-creates it', () => {
    expect(sql).toContain('ALTER TABLE voice_profile');
    expect(sql).not.toContain('CREATE TABLE voice_profile (');
  });

  it('adds the four things 0011 said task 2.7 would add', () => {
    for (const column of ['profile_type', 'name', 'bound_engine_id', 'voice_prompt_id']) {
      expect(sql).toContain(`ADD COLUMN ${column}`);
    }
  });

  it('introduces no second lifecycle flag', () => {
    // 0011's `consent_state` is the only state a profile has. A column with `state` or `status`
    // in its name here would be exactly the duplication the two tasks agreed to avoid.
    expect(sql).not.toMatch(/ADD COLUMN \w*(state|status)\w*/u);
  });
});

describe('the name and sample bounds (Requirements 26.1, 26.2, 26.3, 26.7)', () => {
  it('uses the same name window as domain/voice/profile.ts', () => {
    expect(sql).toContain(
      `char_length(btrim(name)) BETWEEN ${String(VOICE_PROFILE_NAME_MIN_LENGTH)} AND ${String(VOICE_PROFILE_NAME_MAX_LENGTH)}`,
    );
  });

  it('uses the same duration window as domain/voice/reference-sample.ts', () => {
    expect(sql).toContain(
      `duration_ms BETWEEN ${String(REFERENCE_SAMPLE_DURATION_MS_MIN)} AND ${String(REFERENCE_SAMPLE_DURATION_MS_MAX)}`,
    );
  });

  it('uses the same sample-rate floor, with no invented ceiling', () => {
    expect(sql).toContain(`sample_rate >= ${String(REFERENCE_SAMPLE_SAMPLE_RATE_MIN)}`);
  });

  it('uses the same 10-sample cap and enforces it at write time (26.7)', () => {
    expect(sql).toContain(`v_count + 1 > ${String(REFERENCE_SAMPLE_COUNT_MAX)}`);
    expect(sql).toContain('CREATE TRIGGER voice_reference_sample_bounds');
  });

  it('refuses a reference sample on a preset profile (26.9)', () => {
    expect(sql).toContain("IF v_type = 'preset' THEN");
  });
});

describe('the combined prompt predicate (Requirement 26.8)', () => {
  it('mirrors needsCombinedPrompt \u2014 two samples or more', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION voice_profile_needs_combined_prompt');
    expect(sql).toContain('SELECT count(*) >= 2 FROM voice_reference_sample');
  });
});

describe('the preset catalogue and its binding (Requirements 26.9, 26.10, 26.11)', () => {
  it('carries exactly 26.9\u2019s three fields plus a display name', () => {
    expect(sql).toContain('CREATE TABLE preset_voice (');
    for (const column of ['voice_id', 'engine_id', 'language_code', 'display_name']) {
      expect(sql).toContain(column);
    }
  });

  it('enforces 26.10\u2019s binding rather than trusting the writer', () => {
    expect(sql).toContain('CREATE TRIGGER voice_profile_preset_binding');
    expect(sql).toContain('NEW.bound_engine_id <> v_engine');
  });

  it('keeps the catalogue fields on exactly the preset arm', () => {
    expect(sql).toContain('voice_profile_preset_fields');
    expect(sql).toContain("(profile_type = 'preset') = (");
  });

  it('applies the same ISO 639-1 shape the domain does', () => {
    // `domain/speech/language.ts`'s `isLanguageCode` is the same two-letter rule.
    expect(sql).toContain("language_code ~ '^[a-z]{2}$'");
    for (const entry of DEFAULT_PRESET_VOICE_CATALOGUE) {
      expect(entry.languageCode).toMatch(/^[a-z]{2}$/u);
    }
  });
});

describe('the migration set still holds together', () => {
  it('numbers 0012 without a gap or a duplicate', () => {
    const sequences = migrations.map((candidate) => Number(candidate.id.slice(0, 4)));

    expect(sequences).toEqual(
      Array.from({ length: migrations.length }, (_unused, index) => index + 1),
    );
    // Presence and uniqueness, not "0012 is the highest-numbered migration". The
    // gap-free check above is the invariant that matters — it is what guarantees every
    // file runs on a fresh database. Pinning 0012 as the *last* migration would instead
    // be a claim about the future that the next feature to add a table invalidates,
    // which is what happened when task 3.2 added `0013_effect_preset`.
    expect(migrations.filter((candidate) => candidate.id === '0012_voice_profile')).toHaveLength(
      1,
    );
  });

  it('reports every Requirement 26 invariant under one SQLSTATE class', () => {
    // The same class 0011 declares: a caller cannot usefully tell 26.7's bound from 26.19's.
    expect(sql).toContain("ERRCODE = 'MS026'");
  });
});
