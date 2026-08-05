/**
 * Licensing_Service — the commercial-use gate, the credits, and the licence-change fallout.
 *
 * **Validates: Requirements 33.9, 33.10, 33.11, 33.15, 33.16, 33.17, 33.19, 33.22, 33.23, 33.24**
 *
 * ### Why this is a service and not a check inside the download path
 *
 * Requirement 33.11 gates downloads *and* exports; 33.12 gates mixdowns; 33.10 gates generation
 * requests; 33.24 offers a way out of all three. Putting the rule in the download path would
 * mean the mixdown renderer had its own copy, and the copy that drifts is the one nobody looks
 * at. So the ruling lives in `domain/licensing/commercial-gate.ts`, this service supplies it with
 * facts, and every caller asks the same question.
 *
 * ### The gate reads the asset's stored flag, never the engine's current one
 *
 * Requirement 33.17 is explicit: when an engine's permission flips true → false, existing assets
 * are judged by the provenance written at creation. `assertCommercialUseAllowed` therefore reads
 * `record.commercialUseAllowed` — folded at write time by `domain/commercial-use.ts` — and never
 * re-derives it from the engine catalogue.
 *
 * The catalogue *is* read, but only to answer "what would work instead", which is a question
 * about now. That asymmetry is the whole of 33.17, and it is worth stating because the tidy
 * refactor — "look up the engine once and use it for both" — silently applies a licence change
 * retroactively to work a user has already delivered.
 *
 * ### Every download carries the credits, whether or not it is commercial
 *
 * Requirement 33.9 is unconditional. A `non_commercial` download gets the same file: the
 * attribution obligations of the upstream licences do not depend on what the user does next, and
 * a credits file that appeared only for commercial downloads would be missing exactly when a
 * hobbyist publishes a video.
 */

import {
  buildAttributionManifest,
  buildMixAttributionManifest,
  attributionFileName,
  renderAttributionText,
  renderProvenanceExport,
  type AttributionManifest,
  type ProvenanceExport,
} from '../../domain/licensing/attribution';
import {
  commercialRefusalRecord,
  requiresNonCommercialConfirmation,
  ruleOnCommercialUse,
  MAX_ALTERNATIVE_ENGINES,
  type CommercialGateRuling,
} from '../../domain/licensing/commercial-gate';
import { toUsagePurpose, type UsagePurpose } from '../../domain/licensing/usage-purpose';
import { ancestorsOf } from '../../domain/lineage/graph';
import type { AssetKind } from '../../domain/asset-kind';
import type { AuditSinkPort } from '../../adapters/registry/ports';
import type { Clock } from '../clock';
import {
  commercialUseNotPermitted,
  licensingAssetNotFound,
  noCommercialEngineAvailable,
  nonCommercialNoticeNotConfirmed,
} from './errors';
import type {
  AssetLicensingRecord,
  AssetLicensingStore,
  EngineCataloguePort,
  LicenseChangeNotificationPort,
  LineageReadPort,
  RegenerationPort,
} from './ports';

export interface LicensingServiceOptions {
  readonly assets: AssetLicensingStore;
  readonly lineage: LineageReadPort;
  readonly engines: EngineCataloguePort;
  readonly audit: AuditSinkPort;
  readonly clock: Clock;
  readonly notifications?: LicenseChangeNotificationPort;
  readonly regeneration?: RegenerationPort;
}

/** What a download attaches beside the audio (Requirement 33.9). */
export interface AttributionFile {
  readonly fileName: string;
  readonly text: string;
  readonly manifest: AttributionManifest;
}

export function createLicensingService(options: LicensingServiceOptions) {
  const { assets, lineage, engines, audit, clock } = options;

  async function load(assetId: string): Promise<AssetLicensingRecord> {
    const record = await assets.find(assetId);
    if (record === null) throw licensingAssetNotFound(assetId);
    return record;
  }

  /**
   * Requirement 33.11's alternatives: same Asset_Kind, permitted today, at most ten.
   *
   * Sorted by identifier before truncating. Without a stable order the ten a user sees would
   * depend on the catalogue's iteration, and two identical refusals would name different
   * engines — which reads as the list being arbitrary, and it would be.
   */
  async function alternativesFor(assetKind: AssetKind): Promise<readonly string[]> {
    const catalogue = await engines.list();
    return catalogue
      .filter(
        (engine) =>
          engine.commercialUseAllowed && engine.supportedAssetKinds.includes(assetKind),
      )
      .map((engine) => engine.engineId)
      .sort()
      .slice(0, MAX_ALTERNATIVE_ENGINES);
  }

  /**
   * Requirement 33.23's 판정 근거: the licences that actually made the flag false.
   *
   * Not the asset's own weight licence. A derivative restricted by Requirement 33.21 usually
   * carries a permissive licence of its own — it is an ancestor that is not permitted — and
   * naming the derivative's licence would tell the user a permissive identifier is the reason
   * they were refused, which is both wrong and unactionable: they would go looking at the
   * wrong licence and find nothing that says no.
   *
   * So the answer is every non-permitted licence on the asset and on its ancestors within the
   * traversal cap, deduplicated and ordered. Ordered because it is written to an append-only
   * audit entry (33.23) and returned in a refusal, and two identical refusals that listed the
   * same licences in different orders would read as two different decisions.
   */
  async function decidingLicenseIdsFor(record: AssetLicensingRecord): Promise<readonly string[]> {
    const graph = await lineage.graphFor(record.id);
    const ancestorIds = [...ancestorsOf(graph, record.id)];
    const provenance = await assets.provenanceFor([record.id, ...ancestorIds]);

    const deciding = new Set<string>();
    for (const entry of provenance.values()) {
      if (!entry.commercialUseAllowed) deciding.add(entry.weightLicenseId);
    }

    // An ancestor whose provenance the store cannot produce is still a reason — the fold in
    // `domain/commercial-use.ts` treats an unknown provenance as not permitted — but there is
    // no licence identifier to name for it. Falling back to the asset's own licence would put
    // a permissive identifier back in the list, so an empty list is the honest answer.
    return [...deciding].sort();
  }

  async function manifestFor(record: AssetLicensingRecord): Promise<AttributionManifest> {
    const graph = await lineage.graphFor(record.id);
    const ancestorIds = [...graph.parentsOf.keys(), ...graph.childrenOf.keys()];
    const provenance = await assets.provenanceFor([record.id, ...ancestorIds]);
    return buildAttributionManifest(record.id, graph, provenance);
  }

  return {
    /**
     * Requirement 33.19: the purpose every download and export is recorded with.
     *
     * Exposed so a caller records the *parsed* value rather than the raw one. A route that
     * logged `request.query.purpose` would record `undefined` for the common case, and the
     * clause asks for exactly one of two values on every request.
     */
    recordUsagePurpose(value: unknown): UsagePurpose {
      return toUsagePurpose(value);
    },

    /**
     * Requirements 33.11, 33.22, 33.23 — the gate.
     *
     * Throws rather than returning a ruling, because every caller's next step on a refusal is
     * the same: stop. A returned ruling would be a value a caller could forget to check, and
     * Requirement 33.22 calls this a fixed policy.
     */
    async assertCommercialUseAllowed(
      accountId: string,
      assetId: string,
      usagePurposeValue: unknown,
    ): Promise<{ readonly usagePurpose: UsagePurpose; readonly ruling: CommercialGateRuling }> {
      const usagePurpose = toUsagePurpose(usagePurposeValue);
      const record = await load(assetId);

      const ruling = ruleOnCommercialUse({
        usagePurpose,
        // Requirement 33.17: the flag written at creation, not the engine's now.
        assetCommercialUseAllowed: record.commercialUseAllowed,
        decidingLicenseIds: record.commercialUseAllowed
          ? []
          : await decidingLicenseIdsFor(record),
        alternativeEngineIds: await alternativesFor(record.assetKind),
      });

      if (!ruling.allowed) {
        // Requirement 33.23, before the throw: an audit record written after an exception
        // escapes is an audit record that depends on the caller.
        const refusal = commercialRefusalRecord(accountId, assetId, ruling, clock.now().getTime());
        audit.record({
          eventType: 'commercial_use_denied',
          actorId: refusal.accountId,
          targetId: refusal.assetId,
          beforeValue: null,
          afterValue: {
            decidingLicenseIds: refusal.decidingLicenseIds,
            alternativeEngineIds: ruling.alternativeEngineIds,
            usagePurpose,
          },
          eventTime: new Date(refusal.refusedAtMs),
        });

        throw commercialUseNotPermitted({
          assetId,
          decidingLicenseIds: ruling.decidingLicenseIds,
          alternativeEngineIds: ruling.alternativeEngineIds,
        });
      }

      return { usagePurpose, ruling };
    },

    /** Requirement 33.9: the credits file that travels with every download. */
    async attributionFileFor(assetId: string): Promise<AttributionFile> {
      const record = await load(assetId);
      const manifest = await manifestFor(record);
      return {
        fileName: attributionFileName(record.id),
        text: renderAttributionText(manifest),
        manifest,
      };
    },

    /** Requirement 33.13: a mix's credits span every participating clip's lineage. */
    async mixAttributionFor(
      mixAssetId: string,
      participantAssetIds: readonly string[],
    ): Promise<AttributionManifest> {
      const graph = await lineage.graphFor(mixAssetId);
      const provenance = await assets.provenanceFor([
        mixAssetId,
        ...participantAssetIds,
        ...graph.parentsOf.keys(),
      ]);
      return buildMixAttributionManifest(mixAssetId, participantAssetIds, graph, provenance);
    },

    /** Requirement 33.15: the machine-readable document. */
    async exportProvenance(assetId: string): Promise<ProvenanceExport> {
      const record = await load(assetId);
      return renderProvenanceExport(await manifestFor(record), clock.now().getTime());
    },

    /**
     * Requirement 33.10: a generation request naming a non-commercial engine is accepted only
     * after the notice has been confirmed.
     *
     * A gateway rule rather than a screen concern, because the clause says the *request is not
     * accepted* — a form that forgot the checkbox would otherwise submit successfully.
     */
    assertNonCommercialNoticeConfirmed(input: {
      readonly engineId: string;
      readonly engineCommercialUseAllowed: boolean;
      readonly userConfirmedNonCommercialNotice: boolean;
    }): void {
      if (
        requiresNonCommercialConfirmation({
          engineCommercialUseAllowed: input.engineCommercialUseAllowed,
          userConfirmedNonCommercialNotice: input.userConfirmedNonCommercialNotice,
        })
      ) {
        throw nonCommercialNoticeNotConfirmed(input.engineId);
      }
    },

    /**
     * Requirements 33.16, 33.17: an engine's licence changed.
     *
     * Existing assets are **not** rewritten. The clause says their provenance keeps the value
     * from creation time and that requests are judged by it — so the only things that happen
     * here are the audit record and the owners' notifications. A well-meaning migration that
     * flipped stored flags would destroy the evidence 33.17 depends on.
     */
    async recordLicenseChange(input: {
      readonly engineId: string;
      readonly actorId: string;
      readonly before: Readonly<Record<string, unknown>>;
      readonly after: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly notifiedOwnerIds: readonly string[]; readonly affectedAssets: number }> {
      const changedAtMs = clock.now().getTime();

      audit.record({
        eventType: 'license_changed',
        actorId: input.actorId,
        targetId: input.engineId,
        beforeValue: input.before,
        afterValue: input.after,
        eventTime: new Date(changedAtMs),
      });

      const becameNonCommercial =
        input.before.commercialUseAllowed === true && input.after.commercialUseAllowed === false;
      if (!becameNonCommercial || options.notifications === undefined) {
        return { notifiedOwnerIds: [], affectedAssets: 0 };
      }

      // Requirement 33.17: each owner is told once, with the count of their own affected
      // assets — not one message per asset, which for a prolific account is a mailbox full.
      const affected = await assets.listByEngine(input.engineId);
      const byOwner = new Map<string, number>();
      for (const record of affected) {
        byOwner.set(record.ownerId, (byOwner.get(record.ownerId) ?? 0) + 1);
      }

      for (const [ownerId, affectedAssetCount] of byOwner) {
        await options.notifications.notifyOwner({
          ownerId,
          engineId: input.engineId,
          affectedAssetCount,
          changedAtMs,
        });
      }

      return { notifiedOwnerIds: [...byOwner.keys()].sort(), affectedAssets: affected.length };
    },

    /**
     * Requirement 33.24: regenerate a non-commercial asset with an engine that permits it.
     *
     * A **new job with the original parameters**, never an edit of the existing asset — its
     * provenance is immutable (33.7) and its stored flag is what 33.17 judges past requests by.
     */
    async regenerateForCommercialUse(
      ownerId: string,
      assetId: string,
    ): Promise<{ readonly jobId: string; readonly engineId: string }> {
      const record = await load(assetId);
      const candidates = await alternativesFor(record.assetKind);
      const engineId = candidates[0];
      if (engineId === undefined) throw noCommercialEngineAvailable(record.assetKind);
      if (options.regeneration === undefined) {
        throw noCommercialEngineAvailable(record.assetKind);
      }

      const { jobId } = await options.regeneration.submit({
        ownerId,
        engineId,
        assetKind: record.assetKind,
        parameters: record.generationParameters ?? {},
        regeneratedFromAssetId: record.id,
      });
      return { jobId, engineId };
    },
  };
}

export type LicensingService = ReturnType<typeof createLicensingService>;
