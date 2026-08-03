/**
 * The attribution manifest (Requirements 33.9, 33.13, 33.15).
 *
 * Three clauses want the same list in three shapes:
 *
 * | clause | shape | goes with |
 * |---|---|---|
 * | 33.9 | a text file, one entry per asset | every download |
 * | 33.13 | the same entries | a `mix` asset's provenance |
 * | 33.15 | a machine-readable document | an explicit export |
 *
 * So the *list* is built once and rendered twice. Two builders would be two answers to "which
 * assets are in this credit", and the one that drifted would be the one shipped inside a
 * download — the copy a user hands to a client.
 *
 * ### Depth 32 is a bound on the walk, not a filter on the result
 *
 * All three clauses say 계보 깊이 32 이하. That is `MAX_LINEAGE_PATH_DEPTH`, and it is applied by
 * `ancestorsOf` while walking rather than by trimming afterwards: a graph deeper than 32 is one
 * `domain/lineage/invariants.ts` already rejects, and re-deriving the bound here would be a
 * second copy of it.
 *
 * ### An unknown ancestor is recorded, not omitted
 *
 * If an ancestor id has no provenance to hand — a race, a deleted row, a store that answered
 * partially — the entry is still emitted with `provenance: null`. Omitting it would produce a
 * credits file that is silently short, and a short credits file is worse than one that says a
 * line is missing: the user cannot tell.
 */

import { ancestorsOf, type LineageGraph } from '../lineage/graph';
import { MAX_LINEAGE_PATH_DEPTH } from '../lineage/limits';
import { NO_ATTRIBUTION_REQUIRED, type AssetProvenance } from '../provenance';

/** One asset's line in the credits. */
export interface AttributionEntry {
  readonly assetId: string;
  /** `null` when the asset's provenance could not be read — see the module header. */
  readonly engineId: string | null;
  readonly licenseId: string | null;
  readonly attributionText: string | null;
  readonly commercialUseAllowed: boolean | null;
  /** Requirement 33.15 asks for the creation time in the exported document. */
  readonly recordedAtMs: number | null;
  /** True for the asset the manifest is *about*; the rest are ancestors. */
  readonly isSubject: boolean;
}

export interface AttributionManifest {
  readonly subjectAssetId: string;
  readonly entries: readonly AttributionEntry[];
}

function entryFor(
  assetId: string,
  provenance: AssetProvenance | undefined,
  isSubject: boolean,
): AttributionEntry {
  if (provenance === undefined) {
    return {
      assetId,
      engineId: null,
      licenseId: null,
      attributionText: null,
      commercialUseAllowed: null,
      recordedAtMs: null,
      isSubject,
    };
  }
  return {
    assetId,
    engineId: provenance.engineId,
    licenseId: provenance.weightLicenseId,
    attributionText: provenance.attributionText,
    commercialUseAllowed: provenance.commercialUseAllowed,
    recordedAtMs: provenance.recordedAtMs,
    isSubject,
  };
}

/**
 * The asset and every ancestor within depth 32, in a stable order.
 *
 * The subject first, then ancestors sorted by identifier. Sorted rather than in walk order
 * because a graph traversal's order depends on insertion, and a credits file that reordered
 * itself between two downloads of the same asset would look like the credits had changed.
 */
export function buildAttributionManifest(
  subjectAssetId: string,
  graph: LineageGraph,
  provenanceById: ReadonlyMap<string, AssetProvenance>,
  maxDepth: number = MAX_LINEAGE_PATH_DEPTH,
): AttributionManifest {
  const ancestorIds = [...ancestorsOf(graph, subjectAssetId, maxDepth)]
    .filter((id) => id !== subjectAssetId)
    .sort();

  return {
    subjectAssetId,
    entries: [
      entryFor(subjectAssetId, provenanceById.get(subjectAssetId), true),
      ...ancestorIds.map((id) => entryFor(id, provenanceById.get(id), false)),
    ],
  };
}

/**
 * Requirement 33.13: a `mix`'s manifest spans **every** participating asset's lineage, not one
 * clip's. Built by unioning the per-asset walks, so a clip appearing twice contributes once.
 */
export function buildMixAttributionManifest(
  mixAssetId: string,
  participantAssetIds: readonly string[],
  graph: LineageGraph,
  provenanceById: ReadonlyMap<string, AssetProvenance>,
  maxDepth: number = MAX_LINEAGE_PATH_DEPTH,
): AttributionManifest {
  const included = new Set<string>();
  for (const participantId of participantAssetIds) {
    included.add(participantId);
    for (const ancestorId of ancestorsOf(graph, participantId, maxDepth)) {
      included.add(ancestorId);
    }
  }
  included.delete(mixAssetId);

  return {
    subjectAssetId: mixAssetId,
    entries: [
      entryFor(mixAssetId, provenanceById.get(mixAssetId), true),
      ...[...included].sort().map((id) => entryFor(id, provenanceById.get(id), false)),
    ],
  };
}

/** The credits file's name, beside the audio in a download (Requirement 33.9). */
export function attributionFileName(assetId: string): string {
  return `CREDITS-${assetId}.txt`;
}

/**
 * Requirement 33.9's text file: one entry per asset, readable without a tool.
 *
 * A source requiring no attribution still gets a line. The clause asks for an entry per asset,
 * and "this one needs no credit" is information a user forwarding the file to a client needs as
 * much as a name — an omitted line reads as an oversight.
 */
export function renderAttributionText(manifest: AttributionManifest): string {
  const lines: string[] = [
    `자산 출처 및 저작자 표시 — ${manifest.subjectAssetId}`,
    `항목 ${String(manifest.entries.length)}건 (대상 자산 1건 + 계보 조상 ${String(manifest.entries.length - 1)}건, 깊이 ${String(MAX_LINEAGE_PATH_DEPTH)} 이하)`,
    '',
  ];

  for (const entry of manifest.entries) {
    lines.push(`[${entry.isSubject ? '대상' : '조상'}] ${entry.assetId}`);
    lines.push(`  엔진: ${entry.engineId ?? '(출처 정보 없음)'}`);
    lines.push(`  라이선스: ${entry.licenseId ?? '(출처 정보 없음)'}`);
    lines.push(
      `  저작자 표시: ${
        entry.attributionText === null
          ? '(출처 정보 없음)'
          : entry.attributionText === NO_ATTRIBUTION_REQUIRED
            ? '표시 요구 없음'
            : entry.attributionText
      }`,
    );
    lines.push(
      `  상업적 사용: ${
        entry.commercialUseAllowed === null
          ? '(출처 정보 없음)'
          : entry.commercialUseAllowed
            ? '허용'
            : '불허'
      }`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

/** Requirement 33.15's machine-readable document. */
export interface ProvenanceExport {
  readonly formatVersion: 1;
  readonly subjectAssetId: string;
  readonly exportedAtMs: number;
  readonly assets: readonly AttributionEntry[];
}

export function renderProvenanceExport(
  manifest: AttributionManifest,
  exportedAtMs: number,
): ProvenanceExport {
  return {
    formatVersion: 1,
    subjectAssetId: manifest.subjectAssetId,
    exportedAtMs,
    assets: manifest.entries,
  };
}
