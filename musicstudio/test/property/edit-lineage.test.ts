import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EDIT_KINDS, derivationTypeForEditKind } from '../../domain/edit/edit-kind';
import { ancestorsOf, buildLineageGraph } from '../../domain/lineage/graph';
import { MAX_LINEAGE_PATH_DEPTH } from '../../domain/lineage/limits';
import {
  createInMemoryEditLineage,
  editLineageEdges,
  recordEditLineage,
} from '../../services/generation/edit-lineage';
import { isGenerationError } from '../../services/generation/errors';

/**
 * Property 21 — 계보 DAG 비순환 불변식 (design §10 Property 21), applied to the
 * Edit_Task lineage path.
 *
 * **Validates: Requirements 19.7, 19.13**
 *
 * `test/property/lineage-dag.test.ts` establishes Property 21 over arbitrary edges.
 * This asserts the same property over the edges Requirement 7.12 actually produces:
 * an arbitrary sequence of edits, each deriving a fresh asset from some asset already
 * in the graph, must leave the graph acyclic and within depth 32 — and any edit the
 * invariants refuse must leave the recorded lineage exactly as it was.
 *
 * No new property is introduced. The generator is constrained to the shape the edit
 * path can produce — one new child, one existing parent, a `derivation_type` drawn
 * from the five edit kinds — because that is the input space Requirement 7.12 has.
 */

const arbEditKind = fc.constantFrom(...EDIT_KINDS);

interface EditStep {
  readonly parentIndex: number;
  readonly kind: (typeof EDIT_KINDS)[number];
  readonly producedCount: number;
}

const arbEditStep: fc.Arbitrary<EditStep> = fc.record({
  // Resolved modulo the pool of assets that exist when the step runs, so a parent is
  // always an asset that already exists — which is what the gateway guarantees.
  parentIndex: fc.nat({ max: 200 }),
  kind: arbEditKind,
  producedCount: fc.integer({ min: 1, max: 3 }),
});

describe('Property 21 — Edit_Task lineage stays an acyclic DAG within depth 32', () => {
  it('holds for any sequence of edits over the assets already recorded', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbEditStep, { minLength: 1, maxLength: 40 }), async (steps) => {
        const lineage = createInMemoryEditLineage();
        const assets = ['root'];
        let refusals = 0;
        let sequence = 0;

        for (const step of steps) {
          const parent = assets[step.parentIndex % assets.length];
          if (parent === undefined) continue;
          const produced = Array.from(
            { length: step.producedCount },
            () => `asset-${String(++sequence)}`,
          );
          const before = [...lineage.edges];

          try {
            await recordEditLineage(lineage, {
              producedAssetIds: produced,
              sourceAssetIds: [parent],
              derivationType: derivationTypeForEditKind(step.kind),
              assetKind: step.kind === 'extract' ? 'stem' : 'song',
            });
            assets.push(...produced);
          } catch (error) {
            // Requirement 19.13: a refusal leaves existing lineage untouched.
            expect(isGenerationError(error)).toBe(true);
            expect(lineage.edges).toEqual(before);
            refusals += 1;
          }
        }

        const graph = buildLineageGraph(lineage.edges);

        for (const asset of assets) {
          const ancestors = ancestorsOf(graph, asset);
          // Acyclic: no asset is its own ancestor.
          expect(ancestors.has(asset)).toBe(false);
          // Within the depth limit. Every edit here derives from exactly one asset, so
          // the ancestors of any asset form a chain and their count *is* its depth.
          expect(ancestors.size).toBeLessThanOrEqual(MAX_LINEAGE_PATH_DEPTH);
        }

        // Every accepted edge carries one of the five edit kinds.
        for (const edge of lineage.edges) {
          expect(EDIT_KINDS).toContain(edge.derivationType);
        }

        // A well-formed sequence is never refused: each step derives brand-new asset
        // ids from an existing one, so it can only fail on depth, and the depth is
        // bounded by the step count.
        if (steps.length <= MAX_LINEAGE_PATH_DEPTH) expect(refusals).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('never emits a self-derivation, whatever the edit', () => {
    fc.assert(
      fc.property(arbEditKind, fc.string({ minLength: 1 }), (kind, assetId) => {
        const edges = editLineageEdges({
          producedAssetIds: [`${assetId}-derived`],
          sourceAssetIds: [assetId],
          derivationType: derivationTypeForEditKind(kind),
        });

        for (const edge of edges) {
          expect(edge.childAssetId).not.toBe(edge.parentAssetId);
        }
      }),
      { numRuns: 100 },
    );
  });
});
