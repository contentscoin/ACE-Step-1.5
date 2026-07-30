import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildLineageGraph,
  withEdge,
  type LineageEdge,
  type LineageGraph,
} from '../../domain/lineage/graph';
import { checkLineageEdge } from '../../domain/lineage/invariants';
import {
  isMonotonicCommercialUseTransition,
  propagateCommercialUse,
  resolveCommercialUseOnWrite,
  selfCommercialUse,
  verifyCommercialUse,
} from '../../domain/commercial-use';
import { MAX_LINEAGE_PATH_DEPTH } from '../../domain/lineage/limits';

/**
 * Property 18 — 상업적 사용 전파 불변식 (design §10 Property 18, §4.3).
 *
 * **Validates: Requirements 33.20, 33.21**
 *
 * Design §4.3 enforces the flag at write time on a denormalised column and keeps
 * a verification query for drift. These properties pin the two to the same answer
 * and pin the resulting flag to the monotonicity Req 33.21 states as an invariant.
 */

const ASSET_POOL_SIZE = 10;
const assetIds = Array.from({ length: ASSET_POOL_SIZE }, (_unused, index) => `asset-${index}`);

const arbAssetId = fc.constantFrom(...assetIds);

const arbEdge: fc.Arbitrary<LineageEdge> = fc.record({
  childAssetId: arbAssetId,
  parentAssetId: arbAssetId,
  derivationType: fc.constant('effect_apply' as const),
});

const arbSelfFlags = fc.dictionary(arbAssetId, fc.boolean(), {
  minKeys: ASSET_POOL_SIZE,
  maxKeys: ASSET_POOL_SIZE,
});

/** Only edges the lineage rules admit, so every graph here is a valid DAG. */
function acyclicGraph(proposals: readonly LineageEdge[]): LineageGraph {
  let graph = buildLineageGraph([]);
  for (const proposal of proposals) {
    if (checkLineageEdge(graph, proposal).ok) graph = withEdge(graph, proposal);
  }
  return graph;
}

const arbScenario = fc
  .tuple(fc.array(arbEdge, { minLength: 0, maxLength: 30 }), arbSelfFlags)
  .map(([proposals, flags]) => ({
    graph: acyclicGraph(proposals),
    self: new Map(assetIds.map((id) => [id, flags[id] ?? false])),
  }));

describe('Property 18: commercial-use propagation', () => {
  it('never marks an asset permitted when an ancestor is not', () => {
    fc.assert(
      fc.property(arbScenario, ({ graph, self }) => {
        const stored = propagateCommercialUse(graph, self);

        // Req 33.21 holds exactly when the verification query is empty.
        expect(verifyCommercialUse(graph, stored, MAX_LINEAGE_PATH_DEPTH)).toEqual([]);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with the write-time fold over direct parents only', () => {
    fc.assert(
      fc.property(arbScenario, ({ graph, self }) => {
        const stored = propagateCommercialUse(graph, self);

        for (const assetId of assetIds) {
          const directParentFlags = (graph.parentsOf.get(assetId) ?? []).map(
            (parentId) => stored.get(parentId) ?? false,
          );
          const writeTime = resolveCommercialUseOnWrite(
            { provenanceAllowed: self.get(assetId) ?? false, engineAllowed: [] },
            directParentFlags,
          );

          // Req 33.20: direct inputs suffice, by induction over the DAG.
          expect(stored.get(assetId) ?? false).toBe(writeTime);
        }

        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('is monotone: revoking permission never grants it anywhere', () => {
    fc.assert(
      fc.property(arbScenario, arbAssetId, ({ graph, self }, revokedId) => {
        const before = propagateCommercialUse(graph, self);
        const after = propagateCommercialUse(graph, new Map(self).set(revokedId, false));

        for (const assetId of assetIds) {
          const previous = before.get(assetId) ?? false;
          const next = after.get(assetId) ?? false;
          expect(isMonotonicCommercialUseTransition(previous, next)).toBe(true);
        }

        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('cannot be widened by any additional input', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(fc.boolean(), { maxLength: 8 }),
        fc.array(fc.boolean(), { maxLength: 8 }),
        (provenanceAllowed, engineAllowed, parentAllowed) => {
          const own = selfCommercialUse({ provenanceAllowed, engineAllowed });
          const folded = resolveCommercialUseOnWrite(
            { provenanceAllowed, engineAllowed },
            parentAllowed,
          );

          // Req 33.22: the conjunction has no parameter that could re-permit.
          expect(folded).toBe(own && parentAllowed.every(Boolean));
          if (folded) expect(own).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
