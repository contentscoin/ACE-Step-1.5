import { beforeEach, describe, expect, it } from 'vitest';

import { SOFT_DELETE_RETENTION_MS } from '../../../domain/library/bounds';
import { createDownloadService } from '../../../services/library/download-service';
import { createLibraryService } from '../../../services/library/library-service';
import type { DownloadPayload } from '../../../services/library/ports';
import {
  assetRecord,
  inMemoryAssetStore,
  inMemoryPlaylistStore,
  type InMemoryAssetStore,
} from '../../support/library-harness';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * Task 5.1's acceptance criteria, and the clauses behind them: Requirements 11.5, 11.6,
 * 11.8, 11.9, 11.10, 13.1, 13.4, 13.6.
 */

const NOW = 1_700_000_000_000;

function harness(seed = [assetRecord()]) {
  const assets: InMemoryAssetStore = inMemoryAssetStore(seed);
  const playlists = inMemoryPlaylistStore();
  const clock = createMutableClock(new Date(NOW));
  const audited: { eventType: string; targetId: string }[] = [];
  const converted: { objectKey: string; format: string }[] = [];
  let counter = 0;

  const library = createLibraryService({
    assets,
    playlists,
    clock,
    generateId: () => `playlist-${String((counter += 1))}`,
    audit: {
      record: async (event) => {
        audited.push({ eventType: event.eventType, targetId: event.targetId });
      },
    },
  });

  const download = createDownloadService({
    assets,
    loadOwned: library.loadOwned,
    plans: { planIdFor: async (accountId) => (accountId === 'owner-1' ? 'free' : 'studio') },
    conversion: {
      convert: async (request): Promise<DownloadPayload> => {
        converted.push({ objectKey: request.objectKey, format: request.format });
        return { bytes: new Uint8Array([1, 2, 3]), format: request.format, sampleRate: 48_000 };
      },
    },
    archive: {
      archive: async (request) =>
        new Uint8Array(request.entries.map((entry) => entry.fileName.length)),
    },
  });

  return { library, download, assets, playlists, clock, audited, converted };
}

describe('ownership (Requirement 11.9)', () => {
  it.each([
    ['rename', (l: ReturnType<typeof harness>['library']) => l.rename('owner-2', 'asset-a', 'x')],
    ['delete', (l: ReturnType<typeof harness>['library']) => l.softDelete('owner-2', 'asset-a')],
    ['tags', (l: ReturnType<typeof harness>['library']) => l.setTags('owner-2', 'asset-a', ['x'])],
  ])('answers 403 when another account tries to %s', async (_name, act) => {
    const { library } = harness();
    await expect(act(library)).rejects.toMatchObject({
      statusCode: 403,
      code: 'library_asset_forbidden',
    });
  });

  it('answers 404 for an asset that does not exist', async () => {
    const { library } = harness();
    await expect(library.rename('owner-1', 'missing', 'x')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('leaves the asset untouched when it refuses', async () => {
    const { library, assets } = harness();
    await expect(library.rename('owner-2', 'asset-a', 'hijacked')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(assets.rows.get('asset-a')?.name).toBe('Untitled');
  });
});

describe('delete, restore, purge (Requirements 11.6, 11.7, 11.8)', () => {
  it('walks the whole flow', async () => {
    const { library, assets, audited } = harness();

    // 11.6: marked, not gone, and the event recorded.
    await library.softDelete('owner-1', 'asset-a');
    expect(assets.rows.get('asset-a')).toMatchObject({ isDeleted: true, deletedAtMs: NOW });
    expect(audited).toContainEqual({ eventType: 'asset_deleted', targetId: 'asset-a' });

    // 11.7: excluded from a listing while marked.
    expect((await library.list({ ownerId: 'owner-1' })).assets).toHaveLength(0);

    // Restored, and listed again.
    await library.restore('owner-1', 'asset-a');
    expect(assets.rows.get('asset-a')).toMatchObject({ isDeleted: false, deletedAtMs: null });
    expect((await library.list({ ownerId: 'owner-1' })).assets).toHaveLength(1);
  });

  it('purges only after the window has closed (11.8)', async () => {
    const { library, assets, clock } = harness();
    await library.softDelete('owner-1', 'asset-a');

    clock.set(new Date(NOW + SOFT_DELETE_RETENTION_MS - 1));
    expect(await library.purgeExpired()).toEqual([]);
    expect(assets.rows.has('asset-a')).toBe(true);

    clock.set(new Date(NOW + SOFT_DELETE_RETENTION_MS));
    expect(await library.purgeExpired()).toEqual(['asset-a']);
    expect(assets.rows.has('asset-a')).toBe(false);
    expect(assets.purged).toEqual(['asset-a']);
  });

  it('never purges an asset that was restored', async () => {
    const { library, assets, clock } = harness();
    await library.softDelete('owner-1', 'asset-a');
    await library.restore('owner-1', 'asset-a');

    clock.set(new Date(NOW + SOFT_DELETE_RETENTION_MS * 10));
    expect(await library.purgeExpired()).toEqual([]);
    expect(assets.rows.has('asset-a')).toBe(true);
  });
});

describe('rename and tags (Requirements 11.5, 11.3)', () => {
  it('renames and returns the updated asset', async () => {
    const { library } = harness();
    expect(await library.rename('owner-1', 'asset-a', 'Night Drive')).toMatchObject({
      name: 'Night Drive',
    });
  });

  it('stores tags normalised and de-duplicated', async () => {
    const { library } = harness();
    const updated = await library.setTags('owner-1', 'asset-a', [' Lo-Fi ', 'CHILL', 'lo-fi']);
    expect(updated.tags).toEqual(['lo-fi', 'chill']);
  });

  it('refuses a tag set that breaks the rules, and stores nothing', async () => {
    const { library, assets } = harness();
    await expect(
      library.setTags('owner-1', 'asset-a', ['x'.repeat(31)]),
    ).rejects.toMatchObject({ code: 'library_tags_invalid' });
    expect(assets.rows.get('asset-a')?.tags).toEqual([]);
  });
});

describe('playlists (Requirement 11.10)', () => {
  const three = [
    assetRecord({ id: 'a' }),
    assetRecord({ id: 'b' }),
    assetRecord({ id: 'c' }),
  ];

  it('preserves the order the user gave', async () => {
    const { library } = harness(three);
    const playlist = await library.createPlaylist('owner-1', 'Set', ['c', 'a', 'b']);
    expect(playlist.assetIds).toEqual(['c', 'a', 'b']);
  });

  it('stores an asset once, at its first position', async () => {
    const { library } = harness(three);
    const playlist = await library.createPlaylist('owner-1', 'Set', ['c', 'a', 'c']);
    expect(playlist.assetIds).toEqual(['c', 'a']);
  });

  it('replaces the order on a reorder rather than appending', async () => {
    const { library } = harness(three);
    const created = await library.createPlaylist('owner-1', 'Set', ['a', 'b']);
    const reordered = await library.setPlaylistAssets('owner-1', created.id, ['b', 'c', 'a']);
    expect(reordered.assetIds).toEqual(['b', 'c', 'a']);
  });

  it('refuses a playlist naming another account s asset', async () => {
    const { library } = harness([...three, assetRecord({ id: 'x', ownerId: 'owner-2' })]);
    await expect(
      library.createPlaylist('owner-1', 'Set', ['a', 'x']),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses another account s playlist', async () => {
    const { library } = harness(three);
    const created = await library.createPlaylist('owner-1', 'Set', ['a']);
    await expect(
      library.setPlaylistAssets('owner-2', created.id, ['a']),
    ).rejects.toMatchObject({ statusCode: 403, code: 'library_playlist_forbidden' });
  });

  it('refuses an empty name', async () => {
    const { library } = harness(three);
    await expect(library.createPlaylist('owner-1', '', ['a'])).rejects.toMatchObject({
      code: 'library_playlist_invalid',
    });
  });
});

describe('download (Requirements 13.1, 13.4, 13.6, 13.10)', () => {
  it('returns the requested format with the name Requirement 13.6 asks for', async () => {
    const { download } = harness([assetRecord({ name: 'Night Drive' })]);
    const result = await download.download('owner-1', 'asset-a', 'mp3');

    expect(result.format).toBe('mp3');
    expect(result.fileName).toBe('Night Drive (asset-a).mp3');
    expect(result.sampleRate).toBe(48_000);
  });

  it('converts even when the stored format already matches, so 13.7 s tag is applied', async () => {
    const { download, converted } = harness();
    await download.download('owner-1', 'asset-a', 'mp3');
    expect(converted).toEqual([{ objectKey: 'audio/asset-a', format: 'mp3' }]);
  });

  it('refuses lossless on a plan without the entitlement, naming the plans that have it', async () => {
    const { download } = harness();
    await expect(download.download('owner-1', 'asset-a', 'flac')).rejects.toMatchObject({
      statusCode: 402,
      code: 'library_download_refused',
      details: { refusal: 'download_lossless_not_entitled', requiredPlanIds: ['creator', 'studio'] },
    });
  });

  it('allows lossless on a plan that has it', async () => {
    const { download } = harness([assetRecord({ ownerId: 'owner-3' })]);
    await expect(download.download('owner-3', 'asset-a', 'flac')).resolves.toMatchObject({
      format: 'flac',
    });
  });

  it('offers ogg for sfx and refuses it for a song (13.9)', async () => {
    const { download } = harness([
      assetRecord({ id: 'sfx-1', ownerId: 'owner-3', assetKind: 'sfx' }),
      assetRecord({ id: 'song-1', ownerId: 'owner-3' }),
    ]);

    expect(await download.formatsFor('owner-3', 'sfx-1')).toContain('ogg');
    await expect(download.download('owner-3', 'song-1', 'ogg')).rejects.toMatchObject({
      details: { refusal: 'download_format_unsupported_for_kind' },
    });
  });

  it('refuses a download of an asset whose audio is gone', async () => {
    const { download } = harness([assetRecord({ objectKey: null })]);
    await expect(download.download('owner-1', 'asset-a', 'mp3')).rejects.toMatchObject({
      code: 'library_audio_unavailable',
    });
  });

  it('archives the stems of one source (13.5)', async () => {
    const { download } = harness([
      assetRecord({ id: 'song-1', ownerId: 'owner-3', name: 'Night Drive' }),
      assetRecord({ id: 'stem-1', ownerId: 'owner-3', assetKind: 'stem', stemSourceAssetId: 'song-1' }),
      assetRecord({ id: 'stem-2', ownerId: 'owner-3', assetKind: 'stem', stemSourceAssetId: 'song-1' }),
    ]);

    const archive = await download.downloadStems('owner-3', 'song-1', 'wav');
    expect(archive.fileName).toBe('Night Drive (song-1)-stems.zip');
    expect(archive.assetIds).toEqual(['stem-1', 'stem-2']);
  });

  it('refuses a stem archive in a format the plan does not cover', async () => {
    const { download } = harness([
      assetRecord({ id: 'song-1' }),
      assetRecord({ id: 'stem-1', assetKind: 'stem', stemSourceAssetId: 'song-1' }),
    ]);
    await expect(download.downloadStems('owner-1', 'song-1', 'wav')).rejects.toMatchObject({
      statusCode: 402,
    });
  });

  it('answers 403 for another account s download', async () => {
    const { download } = harness();
    await expect(download.download('owner-2', 'asset-a', 'mp3')).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('listing through the service', () => {
  let created: ReturnType<typeof harness>;

  beforeEach(() => {
    created = harness([
      assetRecord({ id: 'a', createdAtMs: 3 }),
      assetRecord({ id: 'b', createdAtMs: 1 }),
      assetRecord({ id: 'c', createdAtMs: 2, assetKind: 'sfx' }),
    ]);
  });

  it('returns the owner s assets newest first', async () => {
    const page = await created.library.list({ ownerId: 'owner-1' });
    expect(page.assets.map((asset) => asset.id)).toEqual(['a', 'c', 'b']);
  });

  it('rejects an invalid listing request rather than guessing', async () => {
    await expect(
      created.library.list({ ownerId: 'owner-1', pageSize: 500 }),
    ).rejects.toMatchObject({ code: 'library_query_invalid' });
  });
});
