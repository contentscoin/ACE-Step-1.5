import { describe, expect, it } from 'vitest';

import { createDownloadService } from '../../../services/library/download-service';
import { createLibraryService } from '../../../services/library/library-service';
import { createLicensingService } from '../../../services/licensing/licensing-service';
import { GenerationError } from '../../../services/generation/errors';
import type { DownloadPayload } from '../../../services/library/ports';
import {
  assetRecord as libraryAsset,
  inMemoryAssetStore,
  inMemoryPlaylistStore,
} from '../../support/library-harness';
import {
  assetRecord,
  createAuditSink,
  createEngineCatalogue,
  createLicensingStore,
  createLineagePort,
  fixedClock,
  provenance,
} from '../../support/licensing-harness';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * The download path with Requirement 33 wired in.
 *
 * **Validates: Requirements 13.4, 33.9, 33.11, 33.19, 33.22**
 *
 * The unit tests either side of this one check the two services separately. What this file
 * checks is the thing neither can: that the download path *calls* the gate, in the right order,
 * and that a refusal stops it before any audio is fetched. A service that composed correctly and
 * a download that forgot to ask would both pass their own tests.
 */

const NOW = 1_700_000_100_000;

function build(options: { readonly commercialUseAllowed: boolean; readonly plan?: string }) {
  const assets = inMemoryAssetStore([
    libraryAsset({ id: 'asset-1', ownerId: 'owner-1', assetKind: 'song', objectKey: 'k/1' }),
  ]);
  const converted: string[] = [];
  const clock = createMutableClock(new Date(NOW));

  const library = createLibraryService({
    assets,
    playlists: inMemoryPlaylistStore(),
    clock,
  });

  const audit = createAuditSink();
  const licensing = createLicensingService({
    assets: createLicensingStore([
      assetRecord('asset-1', {
        commercialUseAllowed: options.commercialUseAllowed,
        provenance: provenance({ weightLicenseId: 'cc-by-nc-4.0', engineId: 'nc-engine' }),
      }),
    ]),
    lineage: createLineagePort([]),
    engines: createEngineCatalogue([
      { engineId: 'alpha', supportedAssetKinds: ['song'], commercialUseAllowed: true },
    ]),
    audit: audit.port,
    clock: fixedClock(NOW).clock,
  });

  const download = createDownloadService({
    assets,
    loadOwned: library.loadOwned,
    plans: { planIdFor: async () => options.plan ?? 'studio' },
    conversion: {
      convert: async (request): Promise<DownloadPayload> => {
        converted.push(request.objectKey);
        return {
          bytes: new Uint8Array([1, 2, 3]),
          format: request.format,
          sampleRate: 48_000,
          tags: request.tags,
        };
      },
    },
    archive: { archive: async () => new Uint8Array([9]) },
    licensing,
  });

  return { download, converted, audit };
}

describe('a download with the licensing gate wired', () => {
  it('records the purpose and attaches the credits on a non-commercial download', async () => {
    const { download } = build({ commercialUseAllowed: false });

    const result = await download.download('owner-1', 'asset-1', 'mp3');

    // Requirement 33.19: exactly one of two values, defaulted.
    expect(result.usagePurpose).toBe('non_commercial');
    // Requirement 33.9 is unconditional — the credits are here even though nothing was gated.
    expect(result.attribution?.fileName).toBe('CREDITS-asset-1.txt');
    expect(result.attribution?.text).toContain('nc-engine');
  });

  it('refuses a commercial download and never fetches the audio (Reqs 33.11, 33.23)', async () => {
    const { download, converted, audit } = build({ commercialUseAllowed: false });

    const error = await download
      .download('owner-1', 'asset-1', 'mp3', 'commercial')
      .then(() => null)
      .catch((thrown: unknown) => thrown as GenerationError);

    expect(error?.code).toBe('commercial_use_not_permitted');
    expect(error?.details.alternativeEngineIds).toEqual(['alpha']);
    // Nothing was converted: a refused request must not cost a worker round trip, and a
    // gate placed after `fetchAudio` would pass every assertion above while doing exactly that.
    expect(converted).toEqual([]);
    expect(audit.drafts.map((draft) => draft.eventType)).toEqual(['commercial_use_denied']);
  });

  it('serves a commercial download of a permitted asset', async () => {
    const { download, converted } = build({ commercialUseAllowed: true });

    const result = await download.download('owner-1', 'asset-1', 'mp3', 'commercial');

    expect(result.usagePurpose).toBe('commercial');
    expect(converted).toEqual(['k/1']);
  });

  it('reports the plan refusal before the licence one (Req 13.4 before 33.11)', async () => {
    // Both would refuse: a free plan cannot take WAV, and the asset is non-commercial.
    const { download } = build({ commercialUseAllowed: false, plan: 'free' });

    const error = await download
      .download('owner-1', 'asset-1', 'wav', 'commercial')
      .then(() => null)
      .catch((thrown: unknown) => thrown as GenerationError);

    // The plan refusal is actionable by upgrading; the licence one is not (33.22). Reporting
    // the licence first would send the user to buy a plan and hit the same wall.
    expect(error?.code).toBe('library_download_refused');
  });

  it('is not opened by a higher plan (Req 33.22)', async () => {
    for (const plan of ['free', 'creator', 'studio']) {
      const { download } = build({ commercialUseAllowed: false, plan });
      const error = await download
        .download('owner-1', 'asset-1', 'mp3', 'commercial')
        .then(() => null)
        .catch((thrown: unknown) => thrown as GenerationError);
      expect(error?.code, plan).toBe('commercial_use_not_permitted');
    }
  });
});
