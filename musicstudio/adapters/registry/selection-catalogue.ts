/**
 * Engine selection list (Requirement 20.9).
 *
 * While an engine is unavailable it must still appear in the user's selection
 * list — marked unavailable — together with the alternative candidates that
 * support the same Asset_Kind. Hiding it would leave the user unable to tell a
 * withdrawn engine from a temporarily failing one.
 */

import type { AssetKind } from '../../domain/asset-kind';

import { isSelectable, type EngineRecord } from './engine-record';
import type { ProviderRegistry } from './provider-registry';

export interface SelectionEntry {
  readonly engineId: string;
  readonly selectable: boolean;
  readonly unavailableReason: 'unavailable' | 'inactive' | null;
  /** Same-kind candidates the user can pick instead (Requirement 20.9). */
  readonly alternativeEngineIds: readonly string[];
  readonly lastCheckedAtMs: number | null;
  readonly lastCheckOutcome: 'success' | 'failure' | null;
  readonly isDefault: boolean;
}

export function selectionCatalogueFor(
  registry: ProviderRegistry,
  assetKind: AssetKind,
): readonly SelectionEntry[] {
  const candidates = registry.enginesSupporting(assetKind);
  const selectableIds = candidates
    .filter(isSelectable)
    .map((record) => record.descriptor.engineId);
  const defaultEngineId = registry.defaultEngineIdFor(assetKind);

  return candidates.map((record) => {
    const engineId = record.descriptor.engineId;
    const selectable = isSelectable(record);
    const latest = record.history.latest;

    return {
      engineId,
      selectable,
      unavailableReason: reasonFor(record),
      alternativeEngineIds: selectable
        ? []
        : selectableIds.filter((candidateId) => candidateId !== engineId),
      lastCheckedAtMs: latest?.checkedAtMs ?? null,
      lastCheckOutcome: latest?.outcome ?? null,
      isDefault: engineId === defaultEngineId,
    };
  });
}

/**
 * Why an engine cannot be picked, or `null` when it can.
 *
 * Operator intent is reported ahead of observed liveness: an engine an operator
 * has withdrawn stays `inactive` in the list even while its probes keep failing,
 * so the two states Requirement 20.22 distinguishes stay distinguishable here.
 * Returns `null` exactly when `isSelectable` is true.
 */
function reasonFor(record: EngineRecord): 'unavailable' | 'inactive' | null {
  if (record.activation !== 'active') return 'inactive';
  if (record.availabilityState.availability !== 'available') return 'unavailable';
  return null;
}
