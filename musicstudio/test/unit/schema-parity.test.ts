import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../db/runner';
import { ASSET_KINDS } from '../../domain/asset-kind';
import { DERIVATION_TYPES } from '../../domain/derivation-type';
import { LINEAGE_INVARIANTS } from '../../domain/lineage/invariants';
import {
  LINEAGE_TRAVERSAL_CAP,
  MAX_LINEAGE_PATH_DEPTH,
  MAX_PARENTS_PER_ASSET,
} from '../../domain/lineage/limits';
import { AUDIT_LOG_MIN_RETENTION_DAYS } from '../../domain/audit-log/partition';
import {
  ASSET_REVIEW_STATES,
  isExcludedFromDiscoveryFeed,
  reviewStateAfterReport,
} from '../../domain/moderation/review-state';
import {
  REPORT_DETAIL_MAX_LENGTH,
  REPORT_REASONS,
} from '../../services/moderation/report-service';

/**
 * Parity guard between the migrations and the pure rules they wrap.
 *
 * The lineage trigger and the commercial-use propagation exist in two languages;
 * they are only "the same rules" for as long as something checks. This suite is
 * that check, and it needs no database.
 */

const migrations = loadMigrations();
const byId = new Map(migrations.map((migration) => [migration.id, migration.sql]));

function sqlOf(id: string): string {
  const sql = byId.get(id);
  if (sql === undefined) throw new Error(`missing migration ${id}`);
  return sql;
}

/** Enum member list of a `CREATE TYPE … AS ENUM (…)` block. */
function enumMembers(sql: string, typeName: string): string[] {
  const pattern = new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`, 'i');
  const body = pattern.exec(sql)?.[1];
  if (body === undefined) throw new Error(`no enum ${typeName} found`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

describe('migration set', () => {
  it('is ordered, gap-free and uniquely numbered', () => {
    const sequences = migrations.map((migration) => Number(migration.id.slice(0, 4)));

    expect(sequences).toEqual(
      Array.from({ length: migrations.length }, (_unused, index) => index + 1),
    );
  });

  it('creates every table the ER diagram requires for this task', () => {
    const allSql = migrations.map((migration) => migration.sql).join('\n');

    for (const table of ['account', 'audio_asset', 'generation_version', 'lineage', 'audit_log']) {
      expect(allSql).toContain(`CREATE TABLE ${table} (`);
    }
  });
});

describe('enum parity (design §4.1, §4.2)', () => {
  it('asset_kind matches the domain list, in order', () => {
    expect(enumMembers(sqlOf('0001_enums'), 'asset_kind')).toEqual([...ASSET_KINDS]);
  });

  it('derivation_type matches the domain list, in order', () => {
    expect(enumMembers(sqlOf('0001_enums'), 'derivation_type')).toEqual([...DERIVATION_TYPES]);
  });
});

describe('lineage trigger parity (design §4.2)', () => {
  const guardSql = sqlOf('0006_lineage_invariants');

  it('uses the same limits as domain/lineage/limits.ts', () => {
    expect(guardSql).toContain(`> ${MAX_PARENTS_PER_ASSET} THEN`);
    expect(guardSql).toContain(`64, v_parent_count + 1`);
    expect(guardSql).toContain(`> ${MAX_LINEAGE_PATH_DEPTH} THEN`);
    expect(guardSql).toContain(`depth < ${LINEAGE_TRAVERSAL_CAP}`);
  });

  it('rejects with every invariant name the domain layer defines', () => {
    const lineageSql = `${sqlOf('0005_lineage')}\n${guardSql}`;

    for (const invariant of LINEAGE_INVARIANTS) {
      expect(lineageSql).toContain(invariant);
    }
  });

  it('names no invariant the domain layer does not define', () => {
    const rejected = [...guardSql.matchAll(/lineage_reject\(\s*'([a-z_]+)'/g)].map(
      (match) => match[1] as string,
    );

    expect(rejected.length).toBeGreaterThan(0);
    for (const invariant of rejected) {
      expect(LINEAGE_INVARIANTS).toContain(invariant);
    }
  });

  it('names a self edge as no_self_derivation, since the trigger precedes the CHECK', () => {
    expect(guardSql).toContain("lineage_reject(\n            'no_self_derivation'");
  });

  it('treats depth as derived rather than caller-supplied', () => {
    expect(guardSql).toContain('NEW.depth := v_ancestor_depth + 1');
  });
});

describe('commercial-use parity (design §4.3)', () => {
  const sql = sqlOf('0007_commercial_use');

  it('enforces the flag at write time and keeps a verification query', () => {
    expect(sql).toContain('CREATE TRIGGER lineage_propagate_commercial_use_after_insert');
    expect(sql).toContain('CREATE VIEW audio_asset_commercial_use_violation');
  });

  it('bounds ancestor traversal at the lineage depth limit', () => {
    expect(sql).toContain(`depth < ${MAX_LINEAGE_PATH_DEPTH}`);
  });

  it('blocks widening the flag and rewriting provenance', () => {
    expect(sql).toContain('WHEN (NOT OLD.commercial_use_allowed AND NEW.commercial_use_allowed)');
    expect(sql).toContain('CREATE TRIGGER audio_asset_no_provenance_rewrite');
  });
});

describe('review state parity (Requirements 16.8, 16.9)', () => {
  const sql = sqlOf('0009_content_report');

  it('asset_review_state matches the domain list, in order', () => {
    expect(enumMembers(sql, 'asset_review_state')).toEqual([...ASSET_REVIEW_STATES]);
  });

  it('report_reason matches the service list, in order', () => {
    expect(enumMembers(sql, 'report_reason')).toEqual([...REPORT_REASONS]);
  });

  it('uses the same report transition as domain/moderation/review-state.ts', () => {
    // reviewStateAfterReport: withheld stays withheld, everything else goes under review.
    expect(reviewStateAfterReport('withheld')).toBe('withheld');
    expect(sql).toContain("WHEN p_current = 'withheld' THEN 'withheld'::asset_review_state");
    expect(sql).toContain("ELSE 'under_review'::asset_review_state");
  });

  it('uses the same discovery-feed exclusion set as the domain predicate', () => {
    const excluded = ASSET_REVIEW_STATES.filter(isExcludedFromDiscoveryFeed);

    expect(sql).toContain(
      `SELECT p_state IN (${excluded.map((state) => `'${state}'`).join(', ')})`,
    );
  });

  it('exposes the exclusion as a view rather than leaving it to each caller', () => {
    expect(sql).toContain('CREATE VIEW audio_asset_discoverable');
    expect(sql).toContain('NOT asset_review_state_excluded_from_feed(review_state)');
  });

  it('guards the review transition and reports it under the Requirement 16 SQLSTATE', () => {
    expect(sql).toContain('CREATE TRIGGER audio_asset_review_transition');
    expect(sql).toContain("ERRCODE = 'MS016'");
  });

  it('keeps the report detail bound at the same length as the service', () => {
    expect(sql).toContain(`char_length(detail) BETWEEN 1 AND ${REPORT_DETAIL_MAX_LENGTH}`);
  });
});

describe('audit log parity (design §4.4)', () => {
  const sql = sqlOf('0008_audit_log');

  it('partitions by month', () => {
    expect(sql).toContain('PARTITION BY RANGE (event_time)');
    expect(sql).toContain("to_char(date_trunc('month', p_month::timestamp), 'YYYY_MM')");
  });

  it('is append-only', () => {
    expect(sql).toContain('CREATE TRIGGER audit_log_no_update');
    expect(sql).toContain('CREATE TRIGGER audit_log_no_delete');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC');
  });

  it('uses the same retention floor as the domain layer', () => {
    expect(sql).toContain(`p_retain_days integer DEFAULT ${AUDIT_LOG_MIN_RETENTION_DAYS}`);
    expect(sql).toContain(`p_retain_days < ${AUDIT_LOG_MIN_RETENTION_DAYS} THEN`);
  });
});
