import { describe, expect, it } from 'vitest';

import { resolveCommercialUseOnWrite } from '../../domain/commercial-use';
import { MAX_ALTERNATIVE_ENGINES } from '../../domain/licensing/commercial-gate';
import { createDownloadService } from '../../services/library/download-service';
import { createLibraryService } from '../../services/library/library-service';
import { createLicensingService } from '../../services/licensing/licensing-service';
import type { DownloadPayload } from '../../services/library/ports';
import {
  assetRecord as libraryAsset,
  inMemoryAssetStore,
  inMemoryPlaylistStore,
} from '../support/library-harness';
import {
  assetRecord,
  createAuditSink,
  createEngineCatalogue,
  createLicensingStore,
  createLineagePort,
  createRegenerationRecorder,
  fixedClock,
  provenance,
} from '../support/licensing-harness';
import { createMutableClock } from '../support/mutable-clock';

/**
 * 라이선싱 플로 — 비상업 조상 → 파생 자산 → `commercial` 다운로드 거부 → 대체 엔진 재생성.
 *
 * **Validates: Requirements 33.11, 33.19, 33.20, 33.21, 33.23, 33.24**
 *
 * A service composition (see `test/e2e/README.md`): Requirement 33 has no routes of its own,
 * it rides on the Requirement 13 download path, and that path is composed here exactly as
 * `services/library/index.ts` composes it.
 *
 * What this adds to `test/unit/licensing/download-integration.test.ts`, which checks the same
 * two services meeting: the refused asset is not the non-commercial one. It is a *derivative*,
 * two edges down, whose own engine permits commercial use and whose flag is false only because
 * `resolveCommercialUseOnWrite` folded its ancestors in. So what the download refuses is a
 * decision taken at write time by a different module — and a product that dropped the fold
 * would serve this file with the gate still passing its own tests.
 *
 * The end of the flow is the way out that Requirement 33.24 offers, because a refusal with no
 * exit is only half the requirement.
 */

const NOW = 1_700_000_100_000;
const OWNER = 'owner-1';

/** Requirement 33.20's write-time fold, run for real rather than asserted. */
const SOURCE_ALLOWED = resolveCommercialUseOnWrite(
  { provenanceAllowed: false, engineAllowed: [false] },
  [],
);
const COVER_ALLOWED = resolveCommercialUseOnWrite(
  { provenanceAllowed: true, engineAllowed: [true] },
  [SOURCE_ALLOWED],
);
const STEM_ALLOWED = resolveCommercialUseOnWrite(
  { provenanceAllowed: true, engineAllowed: [true] },
  [COVER_ALLOWED],
);

/** More permitted engines than Requirement 33.11's cap, so the cap is exercised. */
const COMMERCIAL_ENGINES = Array.from({ length: MAX_ALTERNATIVE_ENGINES + 3 }, (_, index) => ({
  engineId: `engine-${String(index).padStart(2, '0')}`,
  supportedAssetKinds: ['song'] as const,
  commercialUseAllowed: true,
}));

function studio() {
  const converted: { objectKey: string; format: string }[] = [];

  // The three assets as the library knows them: a source, a cover of it, a stem of the cover.
  const assets = inMemoryAssetStore([
    libraryAsset({ id: 'asset-source', ownerId: OWNER, assetKind: 'song', objectKey: 'k/source' }),
    libraryAsset({ id: 'asset-cover', ownerId: OWNER, assetKind: 'song', objectKey: 'k/cover' }),
    libraryAsset({ id: 'asset-stem', ownerId: OWNER, assetKind: 'song', objectKey: 'k/stem' }),
  ]);

  const library = createLibraryService({
    assets,
    playlists: inMemoryPlaylistStore(),
    clock: createMutableClock(new Date(NOW)),
    generateId: () => 'playlist-1',
  });

  const audit = createAuditSink();
  const regeneration = createRegenerationRecorder();

  const licensing = createLicensingService({
    assets: createLicensingStore([
      assetRecord('asset-source', {
        ownerId: OWNER,
        commercialUseAllowed: SOURCE_ALLOWED,
        provenance: provenance({
          engineId: 'nc-engine',
          weightLicenseId: 'cc-by-nc-4.0',
          commercialUseAllowed: false,
          attributionText: 'NC Engine',
        }),
      }),
      assetRecord('asset-cover', {
        ownerId: OWNER,
        commercialUseAllowed: COVER_ALLOWED,
        provenance: provenance({ engineId: 'engine-00', attributionText: 'MusicStudio' }),
      }),
      assetRecord('asset-stem', {
        ownerId: OWNER,
        commercialUseAllowed: STEM_ALLOWED,
        provenance: provenance({ engineId: 'engine-00', attributionText: 'MusicStudio' }),
        generationParameters: { mode: 'custom', caption: 'brushed drums', seed: 7 },
      }),
    ]),
    lineage: createLineagePort([
      { childAssetId: 'asset-cover', parentAssetId: 'asset-source', derivationType: 'cover' },
      { childAssetId: 'asset-stem', parentAssetId: 'asset-cover', derivationType: 'extract' },
    ]),
    engines: createEngineCatalogue([
      { engineId: 'nc-engine', supportedAssetKinds: ['song'], commercialUseAllowed: false },
      ...COMMERCIAL_ENGINES,
    ]),
    audit: audit.port,
    clock: fixedClock(NOW).clock,
    regeneration: regeneration.port,
  });

  const download = createDownloadService({
    assets,
    loadOwned: library.loadOwned,
    plans: { planIdFor: async () => 'studio' },
    licensing,
    conversion: {
      convert: async (request): Promise<DownloadPayload> => {
        converted.push({ objectKey: request.objectKey, format: request.format });
        return {
          bytes: new Uint8Array([1, 2, 3]),
          format: request.format,
          sampleRate: 48_000,
          tags: request.tags,
        };
      },
    },
    archive: { archive: async () => new Uint8Array([9]) },
  });

  return { download, licensing, audit, regeneration, converted };
}

describe('비상업 조상 → 파생 자산 → 상업적 다운로드 거부 → 재생성', () => {
  it('propagates the restriction down the lineage and refuses the derivative', async () => {
    // Requirements 33.20, 33.21 — the fold, before anything is downloaded. The stem's own
    // engine permits commercial use; only its lineage does not.
    expect(SOURCE_ALLOWED).toBe(false);
    expect(STEM_ALLOWED).toBe(false);

    const { download, audit, converted } = studio();

    // Requirement 33.11 — refused, with the reason and the alternatives.
    const refusal = await download
      .download(OWNER, 'asset-stem', 'wav', 'commercial')
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    const details = (refusal as { details?: Record<string, unknown> }).details ?? {};
    expect(details['decidingLicenseIds']).toEqual(['cc-by-nc-4.0']);

    const alternatives = details['alternativeEngineIds'] as readonly string[];
    // At most ten (33.11), all of them permitted, and the non-commercial engine is not
    // among them — an alternative that could not be used would be worse than none.
    expect(alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVE_ENGINES);
    expect(alternatives).toHaveLength(MAX_ALTERNATIVE_ENGINES);
    expect(alternatives).not.toContain('nc-engine');

    // Requirement 33.23 — the refusal is on the record with what it was decided on.
    expect(audit.drafts).toHaveLength(1);
    expect(audit.drafts[0]).toMatchObject({
      eventType: 'commercial_use_denied',
      actorId: OWNER,
      targetId: 'asset-stem',
    });

    // And nothing was fetched. A refusal after the audio had been converted would have
    // handed the file to the caller by the time it threw.
    expect(converted).toEqual([]);
  });

  it('serves the same asset for non-commercial use, credited through the whole lineage', async () => {
    const { download, converted } = studio();

    // Requirement 33.19 — no purpose given, so `non_commercial` applies, and the value is
    // reported rather than left implicit.
    const file = await download.download(OWNER, 'asset-stem', 'wav');

    expect(file.usagePurpose).toBe('non_commercial');
    expect(converted).toEqual([{ objectKey: 'k/stem', format: 'wav' }]);

    // Requirement 33.9 — the credits name the non-commercial ancestor, which is the asset
    // whose licence the user is actually bound by.
    const credited = file.attribution?.manifest.entries.map((entry) => entry.assetId) ?? [];
    expect(credited).toContain('asset-source');
    expect(file.attribution?.text).toContain('cc-by-nc-4.0');
  });

  it('regenerates on a permitted engine, with the original parameters', async () => {
    // Requirement 33.24 — the way out of the refusal, and the reason the alternatives list
    // exists at all.
    const { licensing, regeneration } = studio();

    const { jobId, engineId } = await licensing.regenerateForCommercialUse(OWNER, 'asset-stem');

    expect(jobId).not.toBe('');
    expect(engineId).not.toBe('nc-engine');
    expect(regeneration.submitted).toHaveLength(1);
    expect(regeneration.submitted[0]).toMatchObject({
      ownerId: OWNER,
      engineId,
      regeneratedFromAssetId: 'asset-stem',
      // The same parameters, so what comes back is the same music under a licence that
      // permits the use — not a different song.
      parameters: { mode: 'custom', caption: 'brushed drums', seed: 7 },
    });
  });
});
