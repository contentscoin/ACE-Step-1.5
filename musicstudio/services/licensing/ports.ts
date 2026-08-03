/**
 * The seams the Licensing_Service reads through.
 *
 * Each is a *question*, not a table: "what is this asset's provenance", "what did it descend
 * from", "which engines could do this today". That framing is what lets the service be tested
 * against in-memory answers while the SQL implementation arrives in Phase 9 — and it is why
 * there is no port here for "which plan is this account on".
 *
 * **There is deliberately no account port.** Requirement 33.22 fixes the commercial-use check
 * against the plan, the tier, an operator setting and an API key's permissions. A port for any
 * of those would be a parameter through which the fixed policy could be bypassed, and the
 * absence of one is the enforcement — see `domain/licensing/commercial-gate.ts`.
 */

import type { AssetKind } from '../../domain/asset-kind';
import type { LineageGraph } from '../../domain/lineage/graph';
import type { AssetProvenance } from '../../domain/provenance';

export interface AssetLicensingRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly assetKind: AssetKind;
  /** Written once at creation and never modified (Requirement 33.7). */
  readonly provenance: AssetProvenance;
  /** The stored, lineage-folded flag from `domain/commercial-use.ts` (Requirement 33.21). */
  readonly commercialUseAllowed: boolean;
  /** The parameters a regeneration would reuse (Requirement 33.24). */
  readonly generationParameters?: Readonly<Record<string, unknown>>;
}

export interface AssetLicensingStore {
  find(assetId: string): Promise<AssetLicensingRecord | null>;
  /** Provenance for a set of ids at once — a manifest asks for the whole lineage. */
  provenanceFor(assetIds: readonly string[]): Promise<ReadonlyMap<string, AssetProvenance>>;
  /** Requirement 33.17: the assets an engine produced, to notify their owners. */
  listByEngine(engineId: string): Promise<readonly AssetLicensingRecord[]>;
}

export interface LineageReadPort {
  /** The graph containing this asset and its ancestors, to the traversal cap. */
  graphFor(assetId: string): Promise<LineageGraph>;
}

export interface EngineLicensingSummary {
  readonly engineId: string;
  readonly supportedAssetKinds: readonly AssetKind[];
  /** The engine's permission **now** — see the gate module on why this is not the ruling. */
  readonly commercialUseAllowed: boolean;
}

export interface EngineCataloguePort {
  /** Requirement 33.11's candidates, before the service filters and truncates them. */
  list(): Promise<readonly EngineLicensingSummary[]>;
}

/** Requirement 33.17's 통지, as a seam — email, in-app, whatever Phase 8 wires. */
export interface LicenseChangeNotificationPort {
  notifyOwner(input: {
    readonly ownerId: string;
    readonly engineId: string;
    readonly affectedAssetCount: number;
    readonly changedAtMs: number;
  }): Promise<void>;
}

/** Requirement 33.24: a regeneration is a new job, not an edit of the old asset. */
export interface RegenerationPort {
  submit(input: {
    readonly ownerId: string;
    readonly engineId: string;
    readonly assetKind: AssetKind;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly regeneratedFromAssetId: string;
  }): Promise<{ readonly jobId: string }>;
}
