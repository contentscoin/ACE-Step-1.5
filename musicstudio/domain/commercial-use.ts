/**
 * Commercial-use propagation (design §4.3; Requirements 33.20, 33.21, 33.22).
 *
 * Design §4.3 defines the effective flag as a conjunction over the asset's own
 * provenance, every ancestor within depth 32, and every engine used. Design §4.3
 * also prescribes *write-time* enforcement: store the folded result on the asset
 * and keep a verification query to detect drift.
 *
 * Write-time enforcement only needs the *direct* parents, because each parent's
 * stored flag already folds in its own ancestors. `propagateCommercialUse` and
 * `verifyCommercialUse` are the two halves, and Property 18
 * (`test/property/commercial-use.test.ts`) pins them to the same answer.
 *
 * The policy is fixed: nothing in this module accepts a plan, role or API-key
 * argument, so there is no parameter through which Req 33.22 could be bypassed.
 */

import { MAX_LINEAGE_PATH_DEPTH } from './lineage/limits';
import { ancestorsOf, parentsOf, type LineageGraph } from './lineage/graph';

/** Per-asset inputs to the fold, independent of lineage. */
export interface CommercialUseSelfInputs {
  /** `provenance.commercial_use_allowed` recorded at creation (Req 33.7). */
  readonly provenanceAllowed: boolean;
  /** Commercial-use flag of every engine that touched the asset (Req 33.20). */
  readonly engineAllowed: readonly boolean[];
}

/** The asset's own contribution to the conjunction, before lineage is folded in. */
export function selfCommercialUse(inputs: CommercialUseSelfInputs): boolean {
  return inputs.provenanceAllowed && inputs.engineAllowed.every(Boolean);
}

/**
 * Write-time value for a newly stored asset (Req 33.20): the asset's own inputs
 * conjoined with the *stored* flags of its direct input assets.
 */
export function resolveCommercialUseOnWrite(
  inputs: CommercialUseSelfInputs,
  directParentAllowed: readonly boolean[],
): boolean {
  return selfCommercialUse(inputs) && directParentAllowed.every(Boolean);
}

/**
 * Fold the whole graph in topological order, as the database triggers do
 * incrementally. `self` supplies each asset's own contribution; assets missing
 * from `self` are treated as not permitted, because an unknown provenance can
 * never widen permission.
 */
export function propagateCommercialUse(
  graph: LineageGraph,
  self: ReadonlyMap<string, boolean>,
): Map<string, boolean> {
  const resolved = new Map<string, boolean>();

  const resolve = (assetId: string, seen: ReadonlySet<string>): boolean => {
    const cached = resolved.get(assetId);
    if (cached !== undefined) return cached;
    if (seen.has(assetId)) return false;

    const nextSeen = new Set(seen).add(assetId);
    const own = self.get(assetId) ?? false;
    const value =
      own && parentsOf(graph, assetId).every((parent) => resolve(parent, nextSeen));

    resolved.set(assetId, value);
    return value;
  };

  for (const assetId of assetIdsIn(graph, self)) {
    resolve(assetId, new Set());
  }

  return resolved;
}

function assetIdsIn(graph: LineageGraph, self: ReadonlyMap<string, boolean>): Set<string> {
  const ids = new Set<string>(self.keys());
  for (const child of graph.parentsOf.keys()) ids.add(child);
  for (const parent of graph.childrenOf.keys()) ids.add(parent);
  return ids;
}

export interface CommercialUseViolation {
  readonly assetId: string;
  /** Ancestors within depth 32 that are not permitted (Req 33.21). */
  readonly offendingAncestorIds: readonly string[];
}

/**
 * Verification query analogue of design §4.3: every asset whose stored flag is
 * true while some ancestor within `maxDepth` is false. An empty result is the
 * Req 33.21 invariant holding.
 */
export function verifyCommercialUse(
  graph: LineageGraph,
  stored: ReadonlyMap<string, boolean>,
  maxDepth: number = MAX_LINEAGE_PATH_DEPTH,
): CommercialUseViolation[] {
  const violations: CommercialUseViolation[] = [];

  for (const [assetId, allowed] of stored) {
    if (!allowed) continue;
    const offendingAncestorIds = [...ancestorsOf(graph, assetId, maxDepth)]
      .filter((ancestorId) => stored.get(ancestorId) === false)
      .sort();
    if (offendingAncestorIds.length > 0) {
      violations.push({ assetId, offendingAncestorIds });
    }
  }

  return violations;
}

/**
 * Monotonicity (Req 33.17, 33.21): a stored flag may go true → false when an
 * ancestor or engine loses permission, but never false → true. Re-permitting
 * requires a new asset from a new job (Req 33.24), not an update in place.
 */
export function isMonotonicCommercialUseTransition(previous: boolean, next: boolean): boolean {
  return previous || !next;
}
