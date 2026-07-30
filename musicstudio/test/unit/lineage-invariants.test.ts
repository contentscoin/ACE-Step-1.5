import { describe, expect, it } from 'vitest';

import {
  buildLineageGraph,
  withEdge,
  type LineageEdge,
} from '../../domain/lineage/graph';
import {
  MAX_LINEAGE_PATH_DEPTH,
  MAX_PARENTS_PER_ASSET,
} from '../../domain/lineage/limits';
import {
  checkLineageEdge,
  checkLineageEdges,
  checkLineageRequirement,
  edgeDepth,
} from '../../domain/lineage/invariants';

function edge(child: string, parent: string): LineageEdge {
  return { childAssetId: child, parentAssetId: parent, derivationType: 'cover' };
}

/** A chain root ← a1 ← a2 … where `a{n}` is derived from `a{n-1}`. */
function chain(length: number): LineageEdge[] {
  return Array.from({ length }, (_unused, index) => edge(`a${index + 1}`, `a${index}`));
}

describe('lineage edge invariants (Requirements 19.6, 19.7, 19.13)', () => {
  it('accepts a first derivation and records depth 1', () => {
    const result = checkLineageEdge(buildLineageGraph([]), edge('child', 'parent'));

    expect(result).toEqual({ ok: true, depth: 1 });
  });

  it('reports depth as the longest input chain reaching the child', () => {
    const graph = buildLineageGraph(chain(3));

    expect(edgeDepth(graph, edge('a4', 'a3'))).toBe(4);
  });

  it('rejects a self derivation', () => {
    const result = checkLineageEdge(buildLineageGraph([]), edge('same', 'same'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.invariant).toBe('no_self_derivation');
    expect(result.violations[0]?.assetIds).toEqual(['same']);
  });

  it('rejects a duplicate derivation edge', () => {
    const graph = buildLineageGraph([edge('child', 'parent')]);

    const result = checkLineageEdge(graph, edge('child', 'parent'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((violation) => violation.invariant)).toContain(
      'unique_derivation_edge',
    );
  });

  it('rejects a direct two-node cycle and names both assets', () => {
    const graph = buildLineageGraph([edge('b', 'a')]);

    const result = checkLineageEdge(graph, edge('a', 'b'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const [violation] = result.violations;
    expect(violation?.invariant).toBe('acyclic');
    expect(violation?.assetIds).toEqual(['b', 'a', 'b']);
  });

  it('rejects a longer cycle and returns the closing walk', () => {
    const graph = buildLineageGraph([edge('b', 'a'), edge('c', 'b')]);

    const result = checkLineageEdge(graph, edge('a', 'c'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.invariant).toBe('acyclic');
    expect(result.violations[0]?.assetIds).toEqual(['c', 'b', 'a', 'c']);
  });

  it(`accepts a path of exactly ${MAX_LINEAGE_PATH_DEPTH} edges`, () => {
    const graph = buildLineageGraph(chain(MAX_LINEAGE_PATH_DEPTH - 1));
    const last = edge(`a${MAX_LINEAGE_PATH_DEPTH}`, `a${MAX_LINEAGE_PATH_DEPTH - 1}`);

    expect(checkLineageEdge(graph, last)).toEqual({
      ok: true,
      depth: MAX_LINEAGE_PATH_DEPTH,
    });
  });

  it(`rejects the edge that would make the path ${MAX_LINEAGE_PATH_DEPTH + 1} deep`, () => {
    const graph = buildLineageGraph(chain(MAX_LINEAGE_PATH_DEPTH));

    const result = checkLineageEdge(
      graph,
      edge(`a${MAX_LINEAGE_PATH_DEPTH + 1}`, `a${MAX_LINEAGE_PATH_DEPTH}`),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const [violation] = result.violations;
    expect(violation?.invariant).toBe('max_path_depth');
    expect(violation?.observed).toBe(MAX_LINEAGE_PATH_DEPTH + 1);
    expect(violation?.assetIds).toHaveLength(MAX_LINEAGE_PATH_DEPTH + 2);
  });

  it('counts descendants of the child when measuring the new path', () => {
    // 16 edges below the child plus 16 above the parent is 33 once joined.
    let graph = buildLineageGraph([]);
    for (let index = 0; index < 16; index += 1) {
      graph = withEdge(graph, edge(`below${index}`, index === 0 ? 'child' : `below${index - 1}`));
    }
    for (let index = 0; index < 16; index += 1) {
      graph = withEdge(graph, edge(index === 0 ? 'parent' : `above${index - 1}`, `above${index}`));
    }

    const result = checkLineageEdge(graph, edge('child', 'parent'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.invariant).toBe('max_path_depth');
    expect(result.violations[0]?.observed).toBe(33);
  });

  it(`accepts ${MAX_PARENTS_PER_ASSET} parents and rejects the next one`, () => {
    const parents = Array.from({ length: MAX_PARENTS_PER_ASSET }, (_unused, index) =>
      edge('child', `parent${index}`),
    );
    const graph = buildLineageGraph(parents);

    expect(checkLineageEdges(buildLineageGraph([]), parents).ok).toBe(true);

    const result = checkLineageEdge(graph, edge('child', 'oneMore'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toMatchObject({
      invariant: 'max_parents_per_asset',
      limit: MAX_PARENTS_PER_ASSET,
      observed: MAX_PARENTS_PER_ASSET + 1,
    });
  });

  it('reports which edge of a batch failed so prior lineage is left alone', () => {
    const result = checkLineageEdges(buildLineageGraph([]), [
      edge('b', 'a'),
      edge('c', 'b'),
      edge('a', 'c'),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.edgeIndex).toBe(2);
    expect(result.violations[0]?.invariant).toBe('acyclic');
  });
});

describe('lineage requirement for stem and mix (Requirement 19.7)', () => {
  it.each(['stem', 'mix'] as const)('rejects a parentless %s', (kind) => {
    expect(checkLineageRequirement('asset', kind, 0)).toMatchObject({
      invariant: 'lineage_required',
      assetIds: ['asset'],
    });
  });

  it.each(['stem', 'mix'] as const)('accepts a %s with one input', (kind) => {
    expect(checkLineageRequirement('asset', kind, 1)).toBeUndefined();
  });

  it.each(['song', 'bgm', 'sfx', 'dialogue'] as const)('exempts %s', (kind) => {
    expect(checkLineageRequirement('asset', kind, 0)).toBeUndefined();
  });
});
