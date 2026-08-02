import { describe, expect, it } from 'vitest';

import { EDIT_KINDS, derivationTypeForEditKind } from '../../../domain/edit/edit-kind';
import { buildLineageGraph } from '../../../domain/lineage/graph';
import { checkLineageEdge } from '../../../domain/lineage/invariants';
import {
  MAX_LINEAGE_PATH_DEPTH,
  MAX_PARENTS_PER_ASSET,
} from '../../../domain/lineage/limits';
import {
  createInMemoryEditLineage,
  editLineageEdges,
  recordEditLineage,
  withEditLineage,
} from '../../../services/generation/edit-lineage';
import type { AssetPublicationPort } from '../../../services/generation/ports';
import { isGenerationError } from '../../../services/generation/errors';

/**
 * Requirement 7.12 — lineage for an Edit_Task result.
 *
 * The criterion asks for two things to be stored: the source asset identifier and the
 * edit kind. Both are asserted here as one lineage edge per produced asset, with the
 * edit kind as its `derivation_type`.
 *
 * The invariants are *not* re-tested here — `test/unit/lineage-invariants.test.ts` and
 * `test/property/lineage-dag.test.ts` (task 1.1) already own them. What is tested is
 * that this path goes *through* them rather than around them.
 */

function publicationPort(assetIds: readonly string[]): AssetPublicationPort {
  return { publish: async () => assetIds };
}

describe('Requirement 7.12 — the source asset id and the edit kind are stored as lineage', () => {
  it.each([...EDIT_KINDS])('records one edge per produced asset for %s', (kind) => {
    const edges = editLineageEdges({
      producedAssetIds: ['asset-new-1', 'asset-new-2'],
      sourceAssetIds: ['asset-source'],
      derivationType: derivationTypeForEditKind(kind),
    });

    expect(edges).toEqual([
      { childAssetId: 'asset-new-1', parentAssetId: 'asset-source', derivationType: kind },
      { childAssetId: 'asset-new-2', parentAssetId: 'asset-source', derivationType: kind },
    ]);
  });

  it('appends the edges through the port and reports their stored depth', async () => {
    const lineage = createInMemoryEditLineage();

    const recording = await recordEditLineage(lineage, {
      producedAssetIds: ['asset-new'],
      sourceAssetIds: ['asset-source'],
      derivationType: 'cover',
      assetKind: 'song',
    });

    expect(recording.edges).toHaveLength(1);
    // A first-generation derivative is at depth 1 (`MIN_LINEAGE_PATH_DEPTH`).
    expect(recording.depths).toEqual([1]);
    expect(lineage.edges).toEqual(recording.edges);
  });

  it('deepens with each generation, as task 1.1 computes it', async () => {
    const lineage = createInMemoryEditLineage();

    await recordEditLineage(lineage, {
      producedAssetIds: ['gen-1'],
      sourceAssetIds: ['root'],
      derivationType: 'cover',
      assetKind: 'song',
    });
    const second = await recordEditLineage(lineage, {
      producedAssetIds: ['gen-2'],
      sourceAssetIds: ['gen-1'],
      derivationType: 'repaint',
      assetKind: 'song',
    });

    expect(second.depths).toEqual([2]);
  });
});

describe('Requirement 7.12 goes through task 1.1 invariants rather than around them', () => {
  it('refuses a cycle, using the same check the database trigger implements', async () => {
    const lineage = createInMemoryEditLineage();
    await recordEditLineage(lineage, {
      producedAssetIds: ['derived'],
      sourceAssetIds: ['original'],
      derivationType: 'cover',
      assetKind: 'song',
    });

    // Editing `derived` back into `original` would close a cycle.
    await expect(
      recordEditLineage(lineage, {
        producedAssetIds: ['original'],
        sourceAssetIds: ['derived'],
        derivationType: 'repaint',
        assetKind: 'song',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isGenerationError(error) &&
        error.code === 'edit_lineage_rejected' &&
        JSON.stringify(error.details).includes('acyclic'),
    );

    // Nothing was appended: the rejection left existing lineage untouched (Req 19.13).
    expect(lineage.edges).toHaveLength(1);
  });

  it('refuses a chain that would pass the depth limit', async () => {
    const lineage = createInMemoryEditLineage();
    for (let generation = 0; generation < MAX_LINEAGE_PATH_DEPTH; generation += 1) {
      await recordEditLineage(lineage, {
        producedAssetIds: [`gen-${String(generation + 1)}`],
        sourceAssetIds: [generation === 0 ? 'root' : `gen-${String(generation)}`],
        derivationType: 'cover',
        assetKind: 'song',
      });
    }

    await expect(
      recordEditLineage(lineage, {
        producedAssetIds: ['one-too-many'],
        sourceAssetIds: [`gen-${String(MAX_LINEAGE_PATH_DEPTH)}`],
        derivationType: 'cover',
        assetKind: 'song',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isGenerationError(error) && JSON.stringify(error.details).includes('max_path_depth'),
    );
  });

  it('produces edges the standalone invariant check also accepts', () => {
    const edges = editLineageEdges({
      producedAssetIds: ['child'],
      sourceAssetIds: ['parent'],
      derivationType: 'extract',
    });
    const [edge] = edges;
    if (edge === undefined) throw new Error('expected one edge');

    expect(checkLineageEdge(buildLineageGraph([]), edge).ok).toBe(true);
    expect(MAX_PARENTS_PER_ASSET).toBeGreaterThan(edges.length);
  });
});

describe('Requirement 19.7 — an extract stem always ends up with a parent', () => {
  it('records lineage for a stem produced by an extract', async () => {
    const lineage = createInMemoryEditLineage();
    const publication = withEditLineage(publicationPort(['stem-1', 'stem-2']), lineage);

    const assetIds = await publication.publish({
      accountId: 'user-1',
      jobId: 'job-1',
      assetKind: 'stem',
      engineId: 'ace-step-test',
      results: [],
      sourceAssetIds: ['asset-source'],
      derivationType: 'extract',
    });

    expect(assetIds).toEqual(['stem-1', 'stem-2']);
    expect(lineage.edges).toEqual([
      { childAssetId: 'stem-1', parentAssetId: 'asset-source', derivationType: 'extract' },
      { childAssetId: 'stem-2', parentAssetId: 'asset-source', derivationType: 'extract' },
    ]);
  });

  it('refuses to publish a stem with no source asset at all', async () => {
    const lineage = createInMemoryEditLineage();
    const publication = withEditLineage(publicationPort(['orphan-stem']), lineage);

    await expect(
      publication.publish({
        accountId: 'user-1',
        jobId: 'job-1',
        assetKind: 'stem',
        engineId: 'ace-step-test',
        results: [],
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isGenerationError(error) && JSON.stringify(error.details).includes('lineage_required'),
    );
    expect(lineage.edges).toEqual([]);
  });

  it('leaves a plain song publication alone, recording no lineage', async () => {
    const lineage = createInMemoryEditLineage();
    const publication = withEditLineage(publicationPort(['song-1']), lineage);

    const assetIds = await publication.publish({
      accountId: 'user-1',
      jobId: 'job-1',
      assetKind: 'song',
      engineId: 'ace-step-test',
      results: [],
    });

    expect(assetIds).toEqual(['song-1']);
    expect(lineage.edges).toEqual([]);
  });
});
