/**
 * Lineage DAG limits (design §4.2; Requirements 19.6, 19.7, 19.13).
 *
 * These constants are the single source of truth for the numbers that appear in
 * `db/migrations/0006_lineage_invariants.sql`. `test/unit/schema-parity.test.ts`
 * fails if the SQL and this module ever disagree, so the trigger stays a thin
 * wrapper over the rules defined here rather than a second implementation.
 */

/** Shortest legal lineage path, in edges (Req 19.7). */
export const MIN_LINEAGE_PATH_DEPTH = 1;

/** Longest legal lineage path, in edges (Req 19.7, design §4.2). */
export const MAX_LINEAGE_PATH_DEPTH = 32;

/** Maximum direct input assets per asset (Req 19.6, design §4.2). */
export const MAX_PARENTS_PER_ASSET = 64;

/** `stem` and `mix` always have at least this many input assets (Req 19.7). */
export const MIN_PARENTS_FOR_DERIVED_KIND = 1;

/**
 * Traversal bound for cycle detection and depth measurement.
 *
 * One step beyond the legal maximum: enough to observe an over-long path and
 * report it, and a hard stop for a malformed graph that already contains a cycle.
 */
export const LINEAGE_TRAVERSAL_CAP = MAX_LINEAGE_PATH_DEPTH + 1;
