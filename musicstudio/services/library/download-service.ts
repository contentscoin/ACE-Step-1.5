/**
 * Downloads (Requirements 13.1, 13.2, 13.4-13.9).
 *
 * Split from `library-service.ts` because it needs three seams a listing does not — a
 * converter, an archiver and a plan lookup — and because the ruling it applies is a
 * different question from the ones Requirement 11 asks.
 *
 * The order of the checks is the order the requirements are written in, and it matters:
 * ownership (11.9) before format (13.2/13.9) before entitlement (13.4). Checking the plan
 * first would tell a user their plan is insufficient for a download of someone else's
 * asset, which is both wrong and a disclosure.
 */

import {
  downloadFileName,
  downloadFormatsFor,
  ruleOnDownload,
  stemArchiveFileName,
  type DownloadFormat,
} from '../../domain/library/download';
import { PLANS, findPlan } from '../../domain/credit/plan';
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
}

export interface DownloadResult {
  readonly fileName: string;
  readonly format: DownloadFormat;
  readonly bytes: Uint8Array;
  readonly sampleRate: number;
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
  const { assets, conversion, archive, plans, loadOwned } = options;

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
