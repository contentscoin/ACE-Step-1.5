/**
 * Lineage invariant checks (design §4.2; Requirements 19.6, 19.7, 19.13).
 *
 * This is the authoritative statement of the rules. The PL/pgSQL trigger in
 * `db/migrations/0006_lineage_invariants.sql` implements the same five rules with
 * the same rejection payload — violated invariant plus the offending asset ids
 * (Req 19.13) — and nothing else, so the database cannot drift into a second,
 * subtly different policy.
 */

import { requiresLineage, type AssetKind } from '../asset-kind';

import {
  MAX_LINEAGE_PATH_DEPTH,
  MAX_PARENTS_PER_ASSET,
  MIN_LINEAGE_PATH_DEPTH,
  MIN_PARENTS_FOR_DERIVED_KIND,
} from './limits';
import {
  ancestorPathDepth,
  descendantPathDepth,
  findAncestorPath,
  hasEdge,
  longestAncestorPath,
  longestDescendantPath,
  parentCount,
  withEdge,
  type LineageEdge,
  type LineageGraph,
} from './graph';

export const LINEAGE_INVARIANTS = [
  'no_self_derivation',
  'unique_derivation_edge',
  'max_parents_per_asset',
  'acyclic',
  'max_path_depth',
  'lineage_required',
] as const;

export type LineageInvariant = (typeof LINEAGE_INVARIANTS)[number];

/** Rejection payload required by Req 19.13. */
export interface LineageViolation {
  readonly invariant: LineageInvariant;
  /** Assets that make the invariant fail — the cycle, or the over-long path. */
  readonly assetIds: readonly string[];
  readonly limit: number;
  readonly observed: number;
}

export type LineageCheck =
  | { readonly ok: true; readonly depth: number }
  | { readonly ok: false; readonly violations: readonly LineageViolation[] };

/**
 * Stored depth of an edge: the length of the longest input chain that reaches
 * `edge.childAssetId` through `edge.parentAssetId`. A first-generation
 * derivative has depth 1 (`MIN_LINEAGE_PATH_DEPTH`).
 */
export function edgeDepth(graph: LineageGraph, edge: LineageEdge): number {
  return ancestorPathDepth(graph, edge.parentAssetId) + MIN_LINEAGE_PATH_DEPTH;
}

/**
 * Longest lineage path that would run through `edge` once it exists: the
 * derivatives already below the child, plus the edge, plus the inputs already
 * above the parent. Adding an edge can only lengthen paths through it, so this
 * is the only quantity the depth rule has to bound.
 */
export function pathDepthThroughEdge(graph: LineageGraph, edge: LineageEdge): number {
  return (
    descendantPathDepth(graph, edge.childAssetId) +
    1 +
    ancestorPathDepth(graph, edge.parentAssetId)
  );
}

function deepestPathThroughEdge(graph: LineageGraph, edge: LineageEdge): string[] {
  const below = longestDescendantPath(graph, edge.childAssetId);
  const above = longestAncestorPath(graph, edge.parentAssetId);
  return [...below.slice().reverse(), ...above];
}

/** Check a single prospective edge against `graph`. Never mutates `graph`. */
export function checkLineageEdge(graph: LineageGraph, edge: LineageEdge): LineageCheck {
  const violations: LineageViolation[] = [];

  if (edge.childAssetId === edge.parentAssetId) {
    violations.push({
      invariant: 'no_self_derivation',
      assetIds: [edge.childAssetId],
      limit: 0,
      observed: 1,
    });
    // Every remaining rule degenerates for a self edge; report just this one.
    return { ok: false, violations };
  }

  if (hasEdge(graph, edge)) {
    violations.push({
      invariant: 'unique_derivation_edge',
      assetIds: [edge.childAssetId, edge.parentAssetId],
      limit: 1,
      observed: 2,
    });
  }

  const existingParents = parentCount(graph, edge.childAssetId);
  if (!hasEdge(graph, edge) && existingParents + 1 > MAX_PARENTS_PER_ASSET) {
    violations.push({
      invariant: 'max_parents_per_asset',
      assetIds: [edge.childAssetId],
      limit: MAX_PARENTS_PER_ASSET,
      observed: existingParents + 1,
    });
  }

  const cyclePath = findAncestorPath(graph, edge.parentAssetId, edge.childAssetId);
  if (cyclePath !== undefined) {
    violations.push({
      invariant: 'acyclic',
      // parent → … → child, closed by the edge child → parent.
      assetIds: [...cyclePath, edge.parentAssetId],
      limit: 0,
      observed: cyclePath.length,
    });
    // Depth is unbounded once a cycle exists; the cycle is the actionable report.
    return { ok: false, violations };
  }

  const depthThrough = pathDepthThroughEdge(graph, edge);
  if (depthThrough > MAX_LINEAGE_PATH_DEPTH) {
    violations.push({
      invariant: 'max_path_depth',
      assetIds: deepestPathThroughEdge(graph, edge),
      limit: MAX_LINEAGE_PATH_DEPTH,
      observed: depthThrough,
    });
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, depth: edgeDepth(graph, edge) };
}

/**
 * `lineage_required` (Req 19.7): a `stem` or `mix` always has at least one input
 * asset. Asset-level rather than edge-level, which is why the database checks it
 * with a deferred constraint trigger at commit time.
 */
export function checkLineageRequirement(
  assetId: string,
  assetKind: AssetKind,
  parentCountForAsset: number,
): LineageViolation | undefined {
  if (!requiresLineage(assetKind) || parentCountForAsset >= MIN_PARENTS_FOR_DERIVED_KIND) {
    return undefined;
  }

  return {
    invariant: 'lineage_required',
    assetIds: [assetId],
    limit: MIN_PARENTS_FOR_DERIVED_KIND,
    observed: parentCountForAsset,
  };
}

export interface LineageBatchRejection {
  readonly ok: false;
  /** Index of the edge that failed, so the caller can name the bad input. */
  readonly edgeIndex: number;
  readonly edge: LineageEdge;
  readonly violations: readonly LineageViolation[];
}

export type LineageBatchCheck =
  | { readonly ok: true; readonly depths: readonly number[] }
  | LineageBatchRejection;

/**
 * Check edges as one atomic addition, in order. On rejection the caller must
 * leave existing lineage untouched (Req 19.13); returning the failing index
 * rather than a partial graph keeps that the only possible reading.
 */
export function checkLineageEdges(
  graph: LineageGraph,
  edges: readonly LineageEdge[],
): LineageBatchCheck {
  let working = graph;
  const depths: number[] = [];

  for (const [index, edge] of edges.entries()) {
    const result = checkLineageEdge(working, edge);
    if (!result.ok) {
      return { ok: false, edgeIndex: index, edge, violations: result.violations };
    }
    depths.push(result.depth);
    working = withEdge(working, edge);
  }

  return { ok: true, depths };
}
