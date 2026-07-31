/**
 * Lineage DAG as pure data (design §4.2, §1.4.5).
 *
 * Edges point child → parent, matching the `lineage` table: `parent_asset_id` is
 * an *input* asset of `child_asset_id`. Nothing here touches I/O, so the
 * invariant checks in `invariants.ts` and the properties in
 * `test/property/lineage-dag.test.ts` run without a database.
 */

import type { DerivationType } from '../derivation-type';

import { LINEAGE_TRAVERSAL_CAP } from './limits';

export interface LineageEdge {
  readonly childAssetId: string;
  readonly parentAssetId: string;
  readonly derivationType: DerivationType;
}

export interface LineageGraph {
  /** assetId → its direct input assets. */
  readonly parentsOf: ReadonlyMap<string, readonly string[]>;
  /** assetId → assets directly derived from it. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_LINEAGE_GRAPH: LineageGraph = {
  parentsOf: new Map(),
  childrenOf: new Map(),
};

function append(index: Map<string, string[]>, key: string, value: string): void {
  const bucket = index.get(key);
  if (bucket === undefined) {
    index.set(key, [value]);
    return;
  }
  if (!bucket.includes(value)) {
    bucket.push(value);
  }
}

export function buildLineageGraph(edges: Iterable<LineageEdge>): LineageGraph {
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();

  for (const edge of edges) {
    append(parentsOf, edge.childAssetId, edge.parentAssetId);
    append(childrenOf, edge.parentAssetId, edge.childAssetId);
  }

  return { parentsOf, childrenOf };
}

export function withEdge(graph: LineageGraph, edge: LineageEdge): LineageGraph {
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const [key, values] of graph.parentsOf) parentsOf.set(key, [...values]);
  for (const [key, values] of graph.childrenOf) childrenOf.set(key, [...values]);

  append(parentsOf, edge.childAssetId, edge.parentAssetId);
  append(childrenOf, edge.parentAssetId, edge.childAssetId);

  return { parentsOf, childrenOf };
}

export function parentsOf(graph: LineageGraph, assetId: string): readonly string[] {
  return graph.parentsOf.get(assetId) ?? [];
}

export function childrenOf(graph: LineageGraph, assetId: string): readonly string[] {
  return graph.childrenOf.get(assetId) ?? [];
}

export function parentCount(graph: LineageGraph, assetId: string): number {
  return parentsOf(graph, assetId).length;
}

export function hasEdge(graph: LineageGraph, edge: LineageEdge): boolean {
  return parentsOf(graph, edge.childAssetId).includes(edge.parentAssetId);
}

type Direction = 'up' | 'down';

function neighbours(graph: LineageGraph, assetId: string, direction: Direction): readonly string[] {
  return direction === 'up' ? parentsOf(graph, assetId) : childrenOf(graph, assetId);
}

/**
 * Longest simple path from `assetId` in one direction, as a node list starting
 * at `assetId`.
 *
 * Memoised per node, which is exact on a DAG. A cycle in an already-malformed
 * graph is cut by the on-stack guard rather than looping forever — cycles are
 * rejected by their own check (`invariants.ts`), so the cut value is only ever
 * used to keep this function total.
 */
function longestPath(graph: LineageGraph, assetId: string, direction: Direction): string[] {
  const memo = new Map<string, string[]>();
  const onStack = new Set<string>();

  const walk = (node: string): string[] => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (onStack.has(node)) return [node];

    onStack.add(node);
    let best: string[] = [node];
    for (const next of neighbours(graph, node, direction)) {
      const candidate = [node, ...walk(next)];
      if (candidate.length > best.length) best = candidate;
    }
    onStack.delete(node);

    memo.set(node, best);
    return best;
  };

  return walk(assetId);
}

/** Longest chain of inputs above `assetId`, as `[assetId, parent, …, root]`. */
export function longestAncestorPath(graph: LineageGraph, assetId: string): string[] {
  return longestPath(graph, assetId, 'up');
}

/** Longest chain of derivatives below `assetId`, as `[assetId, child, …, leaf]`. */
export function longestDescendantPath(graph: LineageGraph, assetId: string): string[] {
  return longestPath(graph, assetId, 'down');
}

/** Edge count of the longest chain of inputs above `assetId` (0 for a root). */
export function ancestorPathDepth(graph: LineageGraph, assetId: string): number {
  return longestAncestorPath(graph, assetId).length - 1;
}

/** Edge count of the longest chain of derivatives below `assetId`. */
export function descendantPathDepth(graph: LineageGraph, assetId: string): number {
  return longestDescendantPath(graph, assetId).length - 1;
}

/**
 * A path `[from, …, target]` following input edges upward, or `undefined` when
 * `target` is not an ancestor of `from` within `maxDepth` edges.
 */
export function findAncestorPath(
  graph: LineageGraph,
  from: string,
  target: string,
  maxDepth: number = LINEAGE_TRAVERSAL_CAP,
): string[] | undefined {
  const stack: string[][] = [[from]];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const path = stack.pop();
    if (path === undefined) break;
    const head = path[path.length - 1];
    if (head === undefined) continue;
    if (head === target) return path;
    if (path.length - 1 >= maxDepth || visited.has(head)) continue;
    visited.add(head);
    for (const parent of parentsOf(graph, head)) {
      stack.push([...path, parent]);
    }
  }

  return undefined;
}

/** All input assets reachable from `assetId` within `maxDepth` edges. */
export function ancestorsOf(
  graph: LineageGraph,
  assetId: string,
  maxDepth: number = LINEAGE_TRAVERSAL_CAP,
): Set<string> {
  const found = new Set<string>();
  let frontier: string[] = [assetId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const parent of parentsOf(graph, node)) {
        if (!found.has(parent)) {
          found.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  return found;
}

/** All assets derived from `assetId` within `maxDepth` edges. */
export function descendantsOf(
  graph: LineageGraph,
  assetId: string,
  maxDepth: number = LINEAGE_TRAVERSAL_CAP,
): Set<string> {
  const found = new Set<string>();
  let frontier: string[] = [assetId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of childrenOf(graph, node)) {
        if (!found.has(child)) {
          found.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }

  return found;
}
