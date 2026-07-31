import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../../db/runner';
import { ASSET_KINDS } from '../../../domain/asset-kind';
import { CREDIT_ENTRY_TYPES, CHARGE_KINDS } from '../../../domain/credit/ledger-entry';
import { PLANS } from '../../../domain/credit/plan';
import { DEFAULT_PRICE_ENTRIES } from '../../../services/credit/pricing-table';

/**
 * Parity guard between `0010_credit.sql` and the pure rules it wraps.
 *
 * The plan ceilings and the rate card exist in two languages; they are only "the
 * same table" for as long as something checks. This suite is that check, and it
 * needs no database — the same arrangement task 1.1 uses for the lineage and
 * audit-log rules in `test/unit/schema-parity.test.ts`.
 */

const sql = (() => {
  const migration = loadMigrations().find((candidate) => candidate.id === '0010_credit');
  if (migration === undefined) throw new Error('missing migration 0010_credit');
  return migration.sql;
})();

/** Rows of an `INSERT INTO <table> ... VALUES (...), (...);` block. */
function insertedRows(table: string): string[][] {
  const pattern = new RegExp(`INSERT INTO ${table}[^;]*VALUES([^;]*);`, 'i');
  const body = pattern.exec(sql)?.[1];
  if (body === undefined) throw new Error(`no INSERT INTO ${table} found`);

  return [...body.matchAll(/\(([^)]*)\)/g)].map((match) =>
    (match[1] as string).split(',').map((cell) => cell.trim().replace(/^'|'$/g, '')),
  );
}

function enumMembers(typeName: string): string[] {
  const pattern = new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`, 'i');
  const body = pattern.exec(sql)?.[1];
  if (body === undefined) throw new Error(`no enum ${typeName} found`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

describe('credit migration ordering', () => {
  it('follows the task 1.1 filename convention and extends the sequence', () => {
    // `loadMigrations` itself rejects a bad filename or a duplicate sequence
    // number, so reaching this assertion already proves the convention holds.
    const ids = loadMigrations().map((migration) => migration.id);

    expect(ids).toContain('0010_credit');
    // The credit tables reference `account` and `asset_kind`, so they must be
    // applied after the migrations that create them.
    expect(ids.indexOf('0010_credit')).toBeGreaterThan(ids.indexOf('0002_account'));
    expect(ids.indexOf('0010_credit')).toBeGreaterThan(ids.indexOf('0001_enums'));
  });
});

describe('enum parity', () => {
  it('credit_entry_type matches the domain list, in order', () => {
    expect(enumMembers('credit_entry_type')).toEqual([...CREDIT_ENTRY_TYPES]);
  });

  it('charge_kind matches the domain list, in order', () => {
    expect(enumMembers('charge_kind')).toEqual([...CHARGE_KINDS]);
  });
});

describe('plan parity (Requirements 2.1, 2.5, 2.8, 2.14)', () => {
  it('seeds every plan with the same ceilings as domain/credit/plan.ts', () => {
    const rows = insertedRows('credit_plan');

    expect(rows).toHaveLength(PLANS.length);
    for (const plan of PLANS) {
      expect(rows).toContainEqual([
        plan.planId,
        String(plan.initialCredits),
        String(plan.monthlyCredits),
        String(plan.maxJobsPerMonth),
        String(plan.maxConcurrentJobs),
      ]);
    }
  });

  it('seeds an Asset_Kind cap for every plan and every kind', () => {
    const rows = insertedRows('credit_plan_asset_cap');

    expect(rows).toHaveLength(PLANS.length * ASSET_KINDS.length);
    for (const plan of PLANS) {
      for (const assetKind of ASSET_KINDS) {
        expect(rows).toContainEqual([
          plan.planId,
          assetKind,
          String(plan.maxMonthlyAssetsByKind[assetKind]),
        ]);
      }
    }
  });
});

describe('price parity (Requirement 2.9)', () => {
  it('seeds exactly the entries the service charges from', () => {
    const rows = insertedRows('credit_price');

    expect(rows).toHaveLength(DEFAULT_PRICE_ENTRIES.length);
    for (const entry of DEFAULT_PRICE_ENTRIES) {
      expect(rows).toContainEqual([
        entry.assetKind,
        entry.engineId,
        String(entry.baseCredits),
        String(entry.creditsPerSecond),
      ]);
    }
  });

  it('fails the migration when an Asset_Kind is left unpriced', () => {
    expect(sql).toContain('Requirement 2.9: no credit price registered for Asset_Kind');
  });
});

describe('ledger parity (Requirements 2.2, 2.4)', () => {
  it('is append-only, like the audit log', () => {
    expect(sql).toContain('CREATE TRIGGER credit_ledger_entry_no_update');
    expect(sql).toContain('CREATE TRIGGER credit_ledger_entry_no_delete');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON credit_ledger_entry FROM PUBLIC');
  });

  it('allows one charge and one refund per job', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX credit_ledger_entry_job_once');
    expect(sql).toContain('ON credit_ledger_entry (job_id, entry_type)');
  });

  it('enforces the sign rules the domain validator states', () => {
    expect(sql).toContain('credit_ledger_entry_amount_sign');
    expect(sql).toContain("entry_type = 'charge' AND amount <= 0");
  });

  it('requires a refund to return the full charged amount (Requirement 2.4)', () => {
    expect(sql).toContain('CREATE TRIGGER credit_ledger_entry_refund_matches_charge');
    expect(sql).toContain('refund must return the full charged amount');
  });

  it('uses the MS002 error class for every credit invariant', () => {
    const raises = [...sql.matchAll(/RAISE EXCEPTION[\s\S]*?USING ERRCODE = '([A-Z0-9]+)'/g)].map(
      (match) => match[1],
    );

    expect(raises.length).toBeGreaterThan(0);
    for (const code of raises) expect(code).toBe('MS002');
  });
});

describe('usage view parity (Requirements 2.7, 2.8, 2.14)', () => {
  it('derives the billing period from the newest period-opening entry', () => {
    expect(sql).toContain('CREATE VIEW credit_current_period');
    expect(sql).toContain("WHERE entry_type IN ('initial_grant', 'cycle_renewal')");
  });

  it('excludes refunded jobs from both aggregates, as summariseUsage does', () => {
    const usageView = /CREATE VIEW credit_monthly_usage[\s\S]*?;/.exec(sql)?.[0] ?? '';
    const assetView = /CREATE VIEW credit_monthly_asset_usage[\s\S]*?;/.exec(sql)?.[0] ?? '';

    for (const view of [usageView, assetView]) {
      expect(view).toContain("r.entry_type = 'refund'");
      expect(view).toContain('NOT EXISTS');
    }
  });

  it('keeps a reconciliation query for the cached balance', () => {
    expect(sql).toContain('CREATE VIEW account_credit_balance_violation');
    expect(sql).toContain('WHERE cached_balance <> ledger_balance');
  });
});
