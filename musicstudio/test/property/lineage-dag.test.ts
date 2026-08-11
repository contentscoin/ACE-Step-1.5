import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ancestorsOf,
  buildLineageGraph,
  descendantsOf,
  withEdge,
  type LineageEdge,
  type LineageGraph,
} from '../../domain/lineage/graph';
import {
  MAX_LINEAGE_PATH_DEPTH,
  MAX_PARENTS_PER_ASSET,
  MIN_LINEAGE_PATH_DEPTH,
} from '../../domain/lineage/limits';
import { checkLineageEdge, pathDepthThroughEdge } from '../../domain/lineage/invariants';
import { DERIVATION_TYPES } from '../../domain/derivation-type';

/**
 * Property 21 — 계보 DAG 비순환 불변식 (design §10 Property 21).
 *
 * **Validates: Requirements 19.7, 19.13**
 *
 * The generator proposes arbitrary edges over a small asset pool, including ones
 * that would close a cycle or overrun the depth limit, and accepts only those
 * `checkLineageEdge` approves. The surviving graph must then always be acyclic,
 * within depth 32, and within 64 parents per asset — and every rejection must
 * name the offending assets, since Req 19.13 promises the caller that payload.
 */

const ASSET_POOL_SIZE = 12;
const assetIds = Array.from({ length: ASSET_POOL_SIZE }, (_unused, index) => `asset-${index}`);

const arbAssetId = fc.constantFrom(...assetIds);
const arbDerivationType = fc.constantFrom(...DERIVATION_TYPES);

const arbProposedEdge: fc.Arbitrary<LineageEdge> = fc.record({
  childAssetId: arbAssetId,
  parentAssetId: arbAssetId,
  derivationType: arbDerivationType,
});

/**
 * A deep chain plus arbitrary extra edges: without the chain almost no random
 * edge set reaches depth 32, so the depth rule would never be exercised.
 */
const arbEdgeProposals = fc.tuple(
  fc.integer({ min: 0, max: MAX_LINEAGE_PATH_DEPTH + 4 }),
  fc.array(arbProposedEdge, { minLength: 0, maxLength: 60 }),
);

function chainProposals(length: number): LineageEdge[] {
  return Array.from({ length }, (_unused, index) => ({
    childAssetId: `chain-${index + 1}`,
    parentAssetId: `chain-${index}`,
    derivationType: 'effect_apply' as const,
  }));
}

interface AcceptedGraph {
  readonly graph: LineageGraph;
  readonly accepted: readonly LineageEdge[];
  readonly rejected: number;
}

/** Apply proposals one at a time, keeping only the ones the rules admit. */
function acceptEdges(proposals: readonly LineageEdge[]): AcceptedGraph {
  let graph = buildLineageGraph([]);
  const accepted: LineageEdge[] = [];
  let rejected = 0;

  for (const proposal of proposals) {
    const result = checkLineageEdge(graph, proposal);
    if (!result.ok) {
      rejected += 1;
      // Req 19.13: every rejection identifies the assets that broke the rule.
      expect(result.violations.length).toBeGreaterThan(0);
      for (const violation of result.violations) {
        expect(violation.assetIds.length).toBeGreaterThan(0);
      }
      continue;
    }

    expect(result.depth).toBeGreaterThanOrEqual(MIN_LINEAGE_PATH_DEPTH);
    expect(result.depth).toBeLessThanOrEqual(MAX_LINEAGE_PATH_DEPTH);
    accepted.push(proposal);
    graph = withEdge(graph, proposal);
  }

  return { graph, accepted, rejected };
}

function longestPathDepth(graph: LineageGraph, edges: readonly LineageEdge[]): number {
  return edges.reduce(
    (deepest, edge) => Math.max(deepest, pathDepthThroughEdge(graph, edge)),
    edges.length === 0 ? 0 : MIN_LINEAGE_PATH_DEPTH,
  );
}

describe('Feature: ai-music-generation-service, Property 21: 계보 그래프는 어떤 간선 집합을 받아들여도 순환이 없고 깊이 32를 넘지 않는다 (Requirements 19.7, 19.13)', () => {
  it('admits no edge that would create a cycle or overrun the limits', () => {
    fc.assert(
      fc.property(arbEdgeProposals, ([chainLength, extraProposals]) => {
        const { graph, accepted } = acceptEdges([
          ...chainProposals(chainLength),
          ...extraProposals,
        ]);

        // Acyclic: no asset is its own ancestor.
        for (const assetId of new Set(accepted.flatMap((e) => [e.childAssetId, e.parentAssetId]))) {
          expect(ancestorsOf(graph, assetId).has(assetId)).toBe(false);
          expect(descendantsOf(graph, assetId).has(assetId)).toBe(false);
        }

        // Depth 1..32 (Req 19.7).
        expect(longestPathDepth(graph, accepted)).toBeLessThanOrEqual(MAX_LINEAGE_PATH_DEPTH);

        // At most 64 direct inputs per asset (Req 19.6).
        for (const parents of graph.parentsOf.values()) {
          expect(parents.length).toBeLessThanOrEqual(MAX_PARENTS_PER_ASSET);
        }

        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('rejects every edge whose reverse path already exists', () => {
    fc.assert(
      fc.property(
        fc.array(arbProposedEdge, { minLength: 1, maxLength: 40 }),
        (proposals) => {
          const { graph, accepted } = acceptEdges(proposals);

          for (const edge of accepted) {
            const reverse: LineageEdge = {
              childAssetId: edge.parentAssetId,
              parentAssetId: edge.childAssetId,
              derivationType: edge.derivationType,
            };
            const result = checkLineageEdge(graph, reverse);
            expect(result.ok).toBe(false);
            if (result.ok) return false;
            expect(result.violations.map((violation) => violation.invariant)).toContain('acyclic');
          }

          return true;
        },
      ),
      { numRuns: 150 },
    );
  });

  it('leaves the graph unchanged when an edge is rejected', () => {
    fc.assert(
      fc.property(
        fc.array(arbProposedEdge, { minLength: 1, maxLength: 30 }),
        arbProposedEdge,
        (proposals, candidate) => {
          const { graph } = acceptEdges(proposals);
          const before = JSON.stringify([...graph.parentsOf].sort());

          checkLineageEdge(graph, candidate);

          // Req 19.13: checking is a pure query; existing lineage cannot move.
          expect(JSON.stringify([...graph.parentsOf].sort())).toBe(before);
          return true;
        },
      ),
      { numRuns: 150 },
    );
  });
});
