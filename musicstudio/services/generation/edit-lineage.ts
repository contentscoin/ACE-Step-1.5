/**
 * Requirement 7.12 — lineage for an asset produced by an Edit_Task.
 *
 * "Store the source asset identifier and the edit kind as lineage" is exactly one
 * lineage edge per produced asset: child is the new asset, parent is the source, and
 * `derivation_type` is the edit kind. Nothing new is invented for it — the edge type,
 * the invariants and the SQL all come from task 1.1:
 *
 * - `LineageEdge` and `checkLineageEdges` are `domain/lineage/` (design §4.2:
 *   acyclic, depth ≤ 32, ≤ 64 parents).
 * - `derivationTypeForEditKind` returns a member of the `derivation_type` enum
 *   declared in `db/migrations/0001_enums.sql`, so the value stored here is one the
 *   column already accepts.
 * - `db/migrations/0006_lineage_invariants.sql` re-checks the same rules in the
 *   database, so this is the early, informative rejection rather than the only one.
 *
 * Requirement 19.7 is satisfied structurally rather than by a separate check: an
 * `extract` produces `stem` assets (design §3.6) and every produced asset gets an
 * edge here, so a `stem` with no parent cannot be reached through this path. The
 * check is still asserted, because "cannot happen" is worth failing loudly on.
 */

import { requiresLineage, type AssetKind } from '../../domain/asset-kind';
import type { DerivationType } from '../../domain/derivation-type';
import {
  checkLineageEdges,
  checkLineageRequirement,
  type LineageViolation,
} from '../../domain/lineage/invariants';
import {
  buildLineageGraph,
  EMPTY_LINEAGE_GRAPH,
  type LineageEdge,
} from '../../domain/lineage/graph';
import { MIN_PARENTS_FOR_DERIVED_KIND } from '../../domain/lineage/limits';

import type { EditLineagePort } from './edit-ports';
import { editLineageRejected } from './edit-errors';
import type { AssetPublicationPort, AssetPublicationRequest } from './ports';

export interface EditLineageInput {
  readonly producedAssetIds: readonly string[];
  readonly sourceAssetIds: readonly string[];
  readonly derivationType: DerivationType;
}

/** One edge per (produced asset, source asset) pair, in production order. */
export function editLineageEdges(input: EditLineageInput): readonly LineageEdge[] {
  return input.producedAssetIds.flatMap((childAssetId) =>
    input.sourceAssetIds.map((parentAssetId) => ({
      childAssetId,
      parentAssetId,
      derivationType: input.derivationType,
    })),
  );
}

export interface EditLineageRecording {
  readonly edges: readonly LineageEdge[];
  /** Stored depth per edge, as `edgeDepth` computes it. */
  readonly depths: readonly number[];
}

export interface RecordEditLineageInput extends EditLineageInput {
  /** Requirement 19.7 is checked against the kind of the produced assets. */
  readonly assetKind: AssetKind;
}

/**
 * Validates and appends the edges, or throws `edit_lineage_rejected`.
 *
 * Throwing rather than returning a rejection is deliberate: by the time this runs the
 * engine has already produced audio, so a violation is an internal inconsistency —
 * a source asset that is a descendant of the new one, or a chain past 32 — and not
 * something the caller could have been told earlier.
 */
export async function recordEditLineage(
  port: EditLineagePort,
  input: RecordEditLineageInput,
): Promise<EditLineageRecording> {
  const edges = editLineageEdges(input);
  if (edges.length === 0) {
    const missing = missingLineageViolations(input);
    if (missing.length > 0) throw editLineageRejected(missing);
    return { edges: [], depths: [] };
  }

  const graph = await port.graphFor([...input.producedAssetIds, ...input.sourceAssetIds]);
  const check = checkLineageEdges(graph, edges);
  if (!check.ok) throw editLineageRejected(check.violations, check.edge);

  await port.append(edges);
  return { edges, depths: check.depths };
}

/** Requirement 19.7: a `stem` or `mix` produced with no source at all. */
function missingLineageViolations(input: RecordEditLineageInput): readonly LineageViolation[] {
  if (!requiresLineage(input.assetKind)) return [];
  return input.producedAssetIds
    .map((assetId) => checkLineageRequirement(assetId, input.assetKind, 0))
    .filter((violation): violation is LineageViolation => violation !== undefined);
}

/**
 * Wraps an `AssetPublicationPort` so an Edit_Task's results get their lineage.
 *
 * A decorator rather than a change to whoever implements publication, for two
 * reasons. It keeps Requirement 7.12 true regardless of which Library_Service
 * implementation is wired in — including the in-memory one used in tests — and it
 * keeps the lineage write *after* the assets exist, which the foreign keys in
 * `db/migrations/0005_lineage.sql` require.
 */
export function withEditLineage(
  inner: AssetPublicationPort,
  lineage: EditLineagePort,
): AssetPublicationPort {
  return {
    async publish(request: AssetPublicationRequest): Promise<readonly string[]> {
      const assetIds = await inner.publish(request);
      const sourceAssetIds = request.sourceAssetIds ?? [];
      const derivationType = request.derivationType;

      if (derivationType === undefined || sourceAssetIds.length === 0) {
        // Not a derivation. Requirement 19.7 still applies to the *kind*, so a
        // `stem` or `mix` arriving with no source is reported rather than stored
        // parentless.
        if (requiresLineage(request.assetKind) && assetIds.length > 0) {
          throw editLineageRejected(
            assetIds
              .map((assetId) =>
                checkLineageRequirement(assetId, request.assetKind, MIN_PARENTS_FOR_DERIVED_KIND - 1),
              )
              .filter((violation): violation is LineageViolation => violation !== undefined),
          );
        }
        return assetIds;
      }

      await recordEditLineage(lineage, {
        producedAssetIds: assetIds,
        sourceAssetIds,
        derivationType,
        assetKind: request.assetKind,
      });

      return assetIds;
    },
  };
}

export interface InMemoryEditLineage extends EditLineagePort {
  readonly edges: readonly LineageEdge[];
}

/**
 * In-memory `EditLineagePort`, for compositions with no Library_Service yet.
 *
 * It builds the graph with task 1.1's own `buildLineageGraph`, so the invariant
 * checks see exactly the structure the database would present them with.
 */
export function createInMemoryEditLineage(): InMemoryEditLineage {
  const edges: LineageEdge[] = [];

  return {
    edges,
    graphFor: async () => (edges.length === 0 ? EMPTY_LINEAGE_GRAPH : buildLineageGraph(edges)),
    append: async (appended) => {
      edges.push(...appended);
    },
  };
}
