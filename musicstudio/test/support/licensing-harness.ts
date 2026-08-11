/**
 * In-memory doubles for the Licensing_Service's seams.
 *
 * The lineage is built with `buildLineageGraph` — the real one — rather than a hand-rolled map,
 * so a test's graph is a graph the domain's own invariants accept. A fixture that could express
 * a cycle would let a test pass against an arrangement the product refuses.
 */

import { buildLineageGraph, type LineageEdge, type LineageGraph } from '../../domain/lineage/graph';
import { watermarkId } from '../../domain/disclosure/ai-disclosure';
import type { AssetProvenance } from '../../domain/provenance';
import type { AuditLogDraft } from '../../domain/audit-log/entry';
import type {
  AssetLicensingRecord,
  AssetLicensingStore,
  EngineCataloguePort,
  EngineLicensingSummary,
  LicenseChangeNotificationPort,
  LineageReadPort,
  RegenerationPort,
} from '../../services/licensing/ports';

export function provenance(overrides: Partial<AssetProvenance> = {}): AssetProvenance {
  return {
    engineId: 'ace-step-1.5',
    weightLicenseId: 'apache-2.0',
    attributionText: 'ACE-Step',
    commercialUseAllowed: true,
    nonCommercialLicenseListVersion: 1,
    recordedAtMs: 1_700_000_000_000,
    aiGenerated: true,
    watermarkId: watermarkId(1),
    ...overrides,
  };
}

export function assetRecord(
  id: string,
  overrides: Partial<AssetLicensingRecord> = {},
): AssetLicensingRecord {
  return {
    id,
    ownerId: 'owner-1',
    assetKind: 'song',
    provenance: provenance(),
    commercialUseAllowed: true,
    ...overrides,
  };
}

export function createLicensingStore(records: readonly AssetLicensingRecord[]) {
  const byId = new Map(records.map((record) => [record.id, record]));

  const store: AssetLicensingStore & { put(record: AssetLicensingRecord): void } = {
    async find(assetId) {
      return byId.get(assetId) ?? null;
    },
    async provenanceFor(assetIds) {
      const found = new Map<string, AssetProvenance>();
      for (const assetId of assetIds) {
        const record = byId.get(assetId);
        if (record !== undefined) found.set(assetId, record.provenance);
      }
      return found;
    },
    async listByEngine(engineId) {
      return [...byId.values()].filter((record) => record.provenance.engineId === engineId);
    },
    put(record) {
      byId.set(record.id, record);
    },
  };
  return store;
}

export function createLineagePort(edges: readonly LineageEdge[]): LineageReadPort {
  const graph: LineageGraph = buildLineageGraph(edges);
  return { async graphFor() { return graph; } };
}

export function createEngineCatalogue(
  engines: readonly EngineLicensingSummary[],
): EngineCataloguePort {
  return { async list() { return engines; } };
}

export function createAuditSink() {
  const drafts: AuditLogDraft[] = [];
  return {
    port: { record: (draft: AuditLogDraft) => void drafts.push(draft) },
    drafts,
  };
}

export function createNotificationRecorder() {
  const sent: {
    ownerId: string;
    engineId: string;
    affectedAssetCount: number;
    changedAtMs: number;
  }[] = [];
  const port: LicenseChangeNotificationPort = {
    async notifyOwner(input) {
      sent.push({ ...input });
    },
  };
  return { port, sent };
}

export function createRegenerationRecorder() {
  const submitted: Record<string, unknown>[] = [];
  let counter = 0;
  const port: RegenerationPort = {
    async submit(input) {
      submitted.push({ ...input });
      counter += 1;
      return { jobId: `job-regen-${String(counter)}` };
    },
  };
  return { port, submitted };
}

/** A clock a test moves, matching `services/clock.ts`'s shape. */
export function fixedClock(atMs: number) {
  let current = atMs;
  return {
    clock: { now: () => new Date(current) },
    advance(ms: number) {
      current += ms;
    },
  };
}
