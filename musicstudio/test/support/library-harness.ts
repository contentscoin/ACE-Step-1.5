/**
 * In-memory stores for `Library_Service` (Requirements 11, 13).
 *
 * The asset store's `page` is literally `applyLibraryQuery`, which is the point of the seam
 * `services/library/ports.ts` describes: the listing rules live in the domain, and a store —
 * this one or a SQL one — implements the same function rather than its own reading of it.
 */

import { applyLibraryQuery, type LibraryPage, type LibraryQuery } from '../../domain/library/query';
import type { AssetKind } from '../../domain/asset-kind';
import type {
  LibraryAssetRecord,
  LibraryAssetStore,
  PlaylistRecord,
  PlaylistStore,
} from '../../services/library/ports';

export function assetRecord(overrides: Partial<LibraryAssetRecord> = {}): LibraryAssetRecord {
  return {
    id: 'asset-a',
    ownerId: 'owner-1',
    name: 'Untitled',
    assetKind: 'song' as AssetKind,
    caption: '',
    lyrics: '',
    tags: [],
    playCount: 0,
    createdAtMs: 1_700_000_000_000,
    isDeleted: false,
    deletedAtMs: null,
    objectKey: 'audio/asset-a',
    sampleRate: 48_000,
    channels: 2,
    durationMs: 60_000,
    stemSourceAssetId: null,
    ...overrides,
  };
}

export interface InMemoryAssetStore extends LibraryAssetStore {
  /** The rows, for a test that wants to assert on stored state rather than on a response. */
  readonly rows: Map<string, LibraryAssetRecord>;
  readonly purged: string[];
}

export function inMemoryAssetStore(seed: readonly LibraryAssetRecord[] = []): InMemoryAssetStore {
  const rows = new Map(seed.map((record) => [record.id, record]));
  const purged: string[] = [];

  function require(assetId: string): LibraryAssetRecord {
    const record = rows.get(assetId);
    if (record === undefined) throw new Error(`no such asset: ${assetId}`);
    return record;
  }

  return {
    rows,
    purged,
    find: async (assetId) => rows.get(assetId) ?? null,
    page: async (query: LibraryQuery): Promise<LibraryPage> =>
      applyLibraryQuery([...rows.values()], query),
    rename: async (assetId, name) => {
      const next = { ...require(assetId), name };
      rows.set(assetId, next);
      return next;
    },
    setDeleted: async (assetId, isDeleted, atMs) => {
      const next = { ...require(assetId), isDeleted, deletedAtMs: atMs };
      rows.set(assetId, next);
      return next;
    },
    purge: async (assetId) => {
      rows.delete(assetId);
      purged.push(assetId);
    },
    findPurgeDue: async () => [...rows.values()].filter((record) => record.isDeleted),
    setTags: async (assetId, tags) => {
      const next = { ...require(assetId), tags: [...tags] };
      rows.set(assetId, next);
      return next;
    },
    listSoundPackAssets: async () => [],
    listStemsOf: async (sourceAssetId) =>
      [...rows.values()]
        .filter((record) => record.stemSourceAssetId === sourceAssetId)
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
}

export function inMemoryPlaylistStore(): PlaylistStore & { readonly rows: Map<string, PlaylistRecord> } {
  const rows = new Map<string, PlaylistRecord>();
  return {
    rows,
    insert: async (record) => {
      rows.set(record.id, record);
    },
    find: async (playlistId) => rows.get(playlistId) ?? null,
    update: async (record) => {
      rows.set(record.id, record);
    },
    remove: async (playlistId) => {
      rows.delete(playlistId);
    },
    listByOwner: async (ownerId) =>
      [...rows.values()].filter((record) => record.ownerId === ownerId),
  };
}
