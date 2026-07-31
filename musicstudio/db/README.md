# Database layer

PostgreSQL 16 schema for the product layer (design §4, §12). Migrations are plain
SQL applied in filename order and recorded in `schema_migration`; each runs in its
own transaction, so a failure leaves nothing half-applied.

| File | Contents |
| --- | --- |
| `0001_enums.sql` | `asset_kind`, `derivation_type`, the `MS0xx` error classes |
| `0002_account.sql` | `account` (design §4.1) |
| `0003_audio_asset.sql` | `audio_asset` — Asset_Kind, provenance, licence ruling, Quality_Threshold_Set version |
| `0004_generation_version.sql` | `generation_version` (one default, one original per asset) |
| `0005_lineage.sql` | `lineage` edges |
| `0006_lineage_invariants.sql` | acyclicity, depth ≤ 32, ≤ 64 parents, stem/mix need an input |
| `0007_commercial_use.sql` | write-time propagation + verification views (design §4.3) |
| `0008_audit_log.sql` | append-only monthly-partitioned audit log (design §4.4) |
| `0009_content_report.sql` | content reports + `audio_asset.review_state` and the discovery-feed view (Req 16.8, 16.9) |

## Where the rules live

The lineage and commercial-use rules are stated once, in `../domain/`:

| Rule | Pure module | SQL |
| --- | --- | --- |
| Lineage invariants, limits, rejection payload | `domain/lineage/invariants.ts`, `domain/lineage/limits.ts` | `lineage_guard()` |
| Commercial-use fold and monotonicity | `domain/commercial-use.ts` | `lineage_propagate_commercial_use()`, `audio_asset_commercial_use_violation` |
| Partition naming and retention floor | `domain/audit-log/partition.ts` | `audit_log_ensure_partition()`, `audit_log_prunable_partitions()` |
| PII masking formats | `domain/audit-log/masking.ts` | `audit_log_email_masked`, `audit_log_api_key_masked` CHECKs |
| Review states, transitions, feed exclusion | `domain/moderation/review-state.ts` | `asset_review_state_after_report()`, `asset_review_state_excluded_from_feed()`, view `audio_asset_discoverable` |

The SQL side is a thin wrapper: same limits, same invariant names, same payload.
`test/unit/schema-parity.test.ts` fails if the two drift apart, and it needs no
database.

Errors carry a custom SQLSTATE and a JSON `DETAIL` naming the violated invariant
and the offending asset ids (Requirement 19.13):

```
MS016  content report / review state transition (Requirement 16)
MS019  Audio_Asset / lineage invariant (Requirement 19)
MS033  commercial-use propagation (Requirement 33)
MS018  audit log append-only / retention (design §4.4)
```

## Applying migrations

`applyMigrations` in `runner.ts` takes anything with a `query(sql)` method, so
`db/` carries no driver dependency.

```ts
import { Client } from 'pg';
import { applyMigrations } from './runner';

const client = new Client({ connectionString: process.env.MUSICSTUDIO_DATABASE_URL });
await client.connect();
await applyMigrations({ query: async (sql) => ({ rows: (await client.query(sql)).rows }) });
```

## Verifying against a real database

```bash
podman run -d --name ms-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=musicstudio \
  -p 55432:5432 docker.io/library/postgres:16-alpine

MUSICSTUDIO_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/musicstudio \
  npm run test:db
```

`test/integration/db-schema.test.ts` skips when `MUSICSTUDIO_DATABASE_URL` is
unset. It **drops and recreates the `public` schema**, so point it at a throwaway
database only.

## Retention

`audit_log_prunable_partitions(retain_days)` refuses anything below 365 days
(design §4.4) and returns whole partitions that have aged out; pruning is
`DROP TABLE` on those partitions, which the append-only triggers do not block.
The migration pre-creates the previous month through twelve months ahead. There is
no `DEFAULT` partition on purpose — a missing month must fail loudly rather than
silently pool into one table.
