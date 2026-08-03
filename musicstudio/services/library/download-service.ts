/**
 * Downloads (Requirements 13.1, 13.2, 13.4-13.9).
 *
 * Split from `library-service.ts` because it needs three seams a listing does not — a
 * converter, an archiver and a plan lookup — and because the ruling it applies is a
 * different question from the ones Requirement 11 asks.
 *
 * The order of the checks is the order the requirements are written in, and it matters:
 * ownership (11.9) before format (13.2/13.9) before entitlement (13.4) before commercial use
 * (33.11). Checking the plan first would tell a user their plan is insufficient for a download
 * of someone else's asset, which is both wrong and a disclosure.
 *
 * ### Where Requirement 33 sits in that order, and why it is last
 *
 * The commercial-use gate runs **after** the plan check, and that is not arbitrary. A refusal
 * naming a plan is actionable by upgrading; a commercial-use refusal is not actionable at all in
 * that direction — Requirement 33.22 fixes it against plan, tier, operator setting and API key.
 * Reporting the licence refusal first would leave a user who *also* lacks the lossless
 * entitlement upgrading their plan and hitting the same wall.
 *
 * The credits file of Requirement 33.9 is attached **unconditionally**, whatever the purpose:
 * upstream attribution obligations do not depend on what the user does next.
 */

import {
  downloadFileName,
  downloadFormatsFor,
  ruleOnDownload,
  stemArchiveFileName,
  type DownloadFormat,
} from '../../domain/library/download';
import { PLANS, findPlan } from '../../domain/credit/plan';
import type { UsagePurpose } from '../../domain/licensing/usage-purpose';
import type { AttributionFile, LicensingService } from '../licensing/licensing-service';
import { libraryAudioUnavailable, libraryDownloadRefused } from './errors';
import type {
  DownloadConversionPort,
  DownloadPayload,
  LibraryAssetRecord,
  LibraryAssetStore,
  PlanEntitlementPort,
  StemArchivePort,
} from './ports';

export interface DownloadServiceOptions {
  readonly assets: LibraryAssetStore;
  readonly conversion: DownloadConversionPort;
  readonly archive: StemArchivePort;
  readonly plans: PlanEntitlementPort;
  /** The shared ownership gate from `createLibraryService`. */
  readonly loadOwned: (ownerId: string, assetId: string) => Promise<LibraryAssetRecord>;
  /**
   * Requirements 33.9, 33.11, 33.19.
   *
   * Optional so the service composes without it in tests that are about Requirement 13 alone —
   * but a deployment without it silently loses the commercial gate, so `index.ts` wires it and
   * `test/unit/licensing/download-integration.test.ts` checks the wired path.
   */
  readonly licensing?: LicensingService;
}

export interface DownloadResult {
  readonly fileName: string;
  readonly format: DownloadFormat;
  readonly bytes: Uint8Array;
  readonly sampleRate: number;
  /** Requirement 33.19: exactly one of two values, on every download. */
  readonly usagePurpose: UsagePurpose;
  /** Requirement 33.9: the credits, beside the audio. Absent only when unwired. */
  readonly attribution?: AttributionFile;
}

export interface StemArchiveResult {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly assetIds: readonly string[];
}

/** Requirement 13.4's "필요한 요금제": the plans whose flag is set, derived not listed. */
export function losslessPlanIds(): readonly string[] {
  return PLANS.filter((plan) => plan.losslessDownload).map((plan) => plan.planId);
}

export function createDownloadService(options: DownloadServiceOptions) {
  const { assets, conversion, archive, plans, loadOwned, licensing } = options;

  async function losslessEntitled(accountId: string): Promise<boolean> {
    const planId = await plans.planIdFor(accountId);
    return findPlan(planId)?.losslessDownload ?? false;
  }

  return {
    /** Requirements 13.2, 13.8, 13.9: what this asset may be downloaded as. */
    async formatsFor(ownerId: string, assetId: string): Promise<readonly DownloadFormat[]> {
      const record = await loadOwned(ownerId, assetId);
      return downloadFormatsFor(record.assetKind);
    },

    /** Requirements 13.1, 13.3, 13.6, 13.7, 13.10. */
    async download(
      ownerId: string,
      assetId: string,
      format: unknown,
      /** Requirement 33.19. Absent means `non_commercial`; the service parses, not the caller. */
      usagePurposeValue?: unknown,
    ): Promise<DownloadResult> {
      const record = await loadOwned(ownerId, assetId);

      const ruling = ruleOnDownload({
        assetKind: record.assetKind,
        format,
        losslessEntitled: await losslessEntitled(ownerId),
        losslessPlanIds: losslessPlanIds(),
      });
      if (!ruling.allowed) {
        throw libraryDownloadRefused(ruling.refusal ?? 'download_format_unknown', {
          assetId,
          requestedFormat: format,
          ...(ruling.offeredFormats === undefined
            ? {}
            : { offeredFormats: ruling.offeredFormats }),
          ...(ruling.requiredPlanIds === undefined
            ? {}
            : { requiredPlanIds: ruling.requiredPlanIds }),
        });
      }

      // Requirements 33.11, 33.19, 33.22, 33.23 — last, and after the plan check. See header.
      // Throws on refusal, so nothing below runs and no audio is fetched for a request that
      // will not be served.
      const purpose =
        licensing === undefined
          ? 'non_commercial'
          : (await licensing.assertCommercialUseAllowed(ownerId, assetId, usagePurposeValue))
              .usagePurpose;

      // The ruling only returns `allowed` for a value it has already narrowed.
      const chosen = format as DownloadFormat;
      const payload = await fetchAudio(record, chosen);

      return {
        // Requirement 13.6.
        fileName: downloadFileName(record.name, record.id, chosen),
        format: payload.format,
        bytes: payload.bytes,
        // Requirement 13.10, reported from what the worker returned rather than assumed.
        sampleRate: payload.sampleRate,
        usagePurpose: purpose,
        // Requirement 33.9 — unconditional, whatever the purpose.
        ...(licensing === undefined
          ? {}
          : { attribution: await licensing.attributionFileFor(assetId) }),
      };
    },

    /**
     * Requirement 13.5: the stems split from one source, as a single archive.
     *
     * Every stem is checked for ownership individually. They share a source and in practice
     * an owner, but "in practice" is not a check, and a stem whose ownership had diverged
     * would otherwise leave through the archive.
     */
    async downloadStems(
      ownerId: string,
      sourceAssetId: string,
      format: unknown,
    ): Promise<StemArchiveResult> {
      const source = await loadOwned(ownerId, sourceAssetId);
      const stems = await assets.listStemsOf(sourceAssetId);
      if (stems.length === 0) throw libraryAudioUnavailable(sourceAssetId);

      const entitled = await losslessEntitled(ownerId);
      const entries: { objectKey: string; fileName: string }[] = [];
      const included: string[] = [];

      for (const stem of stems) {
        await loadOwned(ownerId, stem.id);
        const ruling = ruleOnDownload({
          assetKind: stem.assetKind,
          format,
          losslessEntitled: entitled,
          losslessPlanIds: losslessPlanIds(),
        });
        if (!ruling.allowed) {
          throw libraryDownloadRefused(ruling.refusal ?? 'download_format_unknown', {
            assetId: stem.id,
            requestedFormat: format,
            ...(ruling.offeredFormats === undefined
              ? {}
              : { offeredFormats: ruling.offeredFormats }),
            ...(ruling.requiredPlanIds === undefined
              ? {}
              : { requiredPlanIds: ruling.requiredPlanIds }),
          });
        }
        if (stem.objectKey === null) throw libraryAudioUnavailable(stem.id);

        entries.push({
          objectKey: stem.objectKey,
          fileName: downloadFileName(stem.name, stem.id, format as DownloadFormat),
        });
        included.push(stem.id);
      }

      return {
        fileName: stemArchiveFileName(source.name, source.id),
        bytes: await archive.archive({ entries }),
        assetIds: included,
      };
    },
  };

  async function fetchAudio(
    record: LibraryAssetRecord,
    format: DownloadFormat,
  ): Promise<DownloadPayload> {
    if (record.objectKey === null) throw libraryAudioUnavailable(record.id);
    // Conversion is the worker's (Requirement 13.3, task 3.1). It is called even when the
    // stored format already matches, because the worker is also what applies Requirement
    // 13.7's AI-generated metadata tag — a "no conversion needed" shortcut here would hand
    // back a file without it.
    return conversion.convert({ objectKey: record.objectKey, format });
  }
}
