/**
 * Library_Service — listing, search, rename, deletion, tags, playlists.
 *
 * Requirements 11.1-11.13. Downloads are `download-service.ts`'s (Requirement 13), split
 * off because they need three seams this file does not — a converter, an archiver and a
 * plan lookup — and because a listing should not have to be constructed with them.
 *
 * ### Ownership is checked in one place
 *
 * Requirement 11.9 fixes 403 for a foreign asset, and 11.1 scopes every listing to the
 * owner. Both go through `loadOwned`, the way `Timeline_Service` funnels through its own.
 * A method that read an asset without it would be the one path where 11.9 does not hold.
 *
 * ### What this service does not decide
 *
 * Requirement 11.7's exclusion of deleted assets is `applyLibraryQuery`'s, and 11.8's
 * expiry is `domain/library/retention.ts`'s. Both are reachable from here, and neither is
 * restated: a second copy of "thirty days" is a second answer waiting to drift.
 */

import { randomUUID } from 'node:crypto';

import { PLAYLIST_NAME_MAX_LENGTH, PLAYLIST_NAME_MIN_LENGTH } from '../../domain/library/bounds';
import {
  libraryQueryViolations,
  toLibraryQuery,
  type LibraryPage,
  type LibraryQueryInput,
} from '../../domain/library/query';
import { isPurgeDue, markDeleted, markRestored } from '../../domain/library/retention';
import { normaliseTags, tagViolations } from '../../domain/library/tags';
import { systemClock, type Clock } from '../clock';
import {
  libraryAssetForbidden,
  libraryAssetNotFound,
  libraryPlaylistForbidden,
  libraryPlaylistInvalid,
  libraryPlaylistNotFound,
  libraryQueryInvalid,
  libraryTagsInvalid,
} from './errors';
import type { LibraryAssetRecord, LibraryAssetStore, PlaylistRecord, PlaylistStore } from './ports';

export interface LibraryServiceOptions {
  readonly assets: LibraryAssetStore;
  readonly playlists: PlaylistStore;
  readonly clock?: Clock;
  readonly generateId?: () => string;
  /** Requirement 11.6's 삭제 사건, and 11.8's permanent deletion. */
  readonly audit?: LibraryAuditPort;
}

export interface LibraryAuditPort {
  record(event: {
    readonly eventType: 'asset_deleted' | 'asset_restored' | 'asset_purged';
    readonly actorId: string;
    readonly targetId: string;
    readonly atMs: number;
  }): Promise<void>;
}

export function createLibraryService(options: LibraryServiceOptions) {
  const { assets, playlists } = options;
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? randomUUID;
  const audit = options.audit;

  function nowMs(): number {
    return clock.now().getTime();
  }

  /** Requirements 11.1 and 11.9's single gate. */
  async function loadOwned(ownerId: string, assetId: string): Promise<LibraryAssetRecord> {
    const record = await assets.find(assetId);
    if (record === null) throw libraryAssetNotFound(assetId);
    if (record.ownerId !== ownerId) throw libraryAssetForbidden(assetId);
    return record;
  }

  async function loadOwnedPlaylist(ownerId: string, playlistId: string): Promise<PlaylistRecord> {
    const record = await playlists.find(playlistId);
    if (record === null) throw libraryPlaylistNotFound(playlistId);
    if (record.ownerId !== ownerId) throw libraryPlaylistForbidden(playlistId);
    return record;
  }

  return {
    /** Requirements 11.1-11.4, 11.7, 11.11, 11.12. */
    async list(input: LibraryQueryInput): Promise<LibraryPage> {
      const violations = libraryQueryViolations(input);
      if (violations.length > 0) throw libraryQueryInvalid(violations);
      return assets.page(toLibraryQuery(input));
    },

    /** Requirement 11.5. */
    async rename(ownerId: string, assetId: string, name: string): Promise<LibraryAssetRecord> {
      await loadOwned(ownerId, assetId);
      return assets.rename(assetId, name);
    },

    /** Requirement 11.3's tag management, judged as a set (see `tagViolations`). */
    async setTags(
      ownerId: string,
      assetId: string,
      tags: readonly string[],
    ): Promise<LibraryAssetRecord> {
      await loadOwned(ownerId, assetId);
      const violations = tagViolations(tags);
      if (violations.length > 0) throw libraryTagsInvalid(violations);
      return assets.setTags(assetId, normaliseTags(tags));
    },

    /** Requirement 11.6: mark, and record the event. */
    async softDelete(ownerId: string, assetId: string): Promise<LibraryAssetRecord> {
      await loadOwned(ownerId, assetId);
      const at = nowMs();
      const state = markDeleted(at);
      const record = await assets.setDeleted(assetId, state.isDeleted, state.deletedAtMs);
      await audit?.record({
        eventType: 'asset_deleted',
        actorId: ownerId,
        targetId: assetId,
        atMs: at,
      });
      return record;
    },

    /** Requirement 11.11 names restore among the operations every kind must support. */
    async restore(ownerId: string, assetId: string): Promise<LibraryAssetRecord> {
      await loadOwned(ownerId, assetId);
      const state = markRestored();
      const record = await assets.setDeleted(assetId, state.isDeleted, state.deletedAtMs);
      await audit?.record({
        eventType: 'asset_restored',
        actorId: ownerId,
        targetId: assetId,
        atMs: nowMs(),
      });
      return record;
    },

    /**
     * Requirement 11.8's sweep. Returns what it purged.
     *
     * Operator-triggered rather than owner-triggered — there is no user in 11.8 — so it
     * takes no owner and checks none. The due test is `isPurgeDue`'s, so an asset one hour
     * short of thirty days survives here for the same reason it survives anywhere else.
     */
    async purgeExpired(): Promise<readonly string[]> {
      const at = nowMs();
      const due = await assets.findPurgeDue(at);
      const purged: string[] = [];
      for (const record of due) {
        if (!isPurgeDue(record, at)) continue;
        await assets.purge(record.id);
        await audit?.record({
          eventType: 'asset_purged',
          actorId: record.ownerId,
          targetId: record.id,
          atMs: at,
        });
        purged.push(record.id);
      }
      return purged;
    },

    /** Requirement 11.13, in the order the store returns — cue name ascending. */
    async listSoundPack(packId: string): Promise<readonly LibraryAssetRecord[]> {
      return assets.listSoundPackAssets(packId);
    },

    /** Requirement 11.10. The order given is the order stored. */
    async createPlaylist(
      ownerId: string,
      name: string,
      assetIds: readonly string[],
    ): Promise<PlaylistRecord> {
      assertPlaylistName(name);
      await assertOwnedAssets(ownerId, assetIds);

      const at = nowMs();
      const record: PlaylistRecord = {
        id: generateId(),
        ownerId,
        name,
        assetIds: dedupePreservingOrder(assetIds),
        createdAtMs: at,
        updatedAtMs: at,
      };
      await playlists.insert(record);
      return record;
    },

    /** Requirement 11.10 again: a reorder is a new order, not an append. */
    async setPlaylistAssets(
      ownerId: string,
      playlistId: string,
      assetIds: readonly string[],
    ): Promise<PlaylistRecord> {
      const existing = await loadOwnedPlaylist(ownerId, playlistId);
      await assertOwnedAssets(ownerId, assetIds);

      const record: PlaylistRecord = {
        ...existing,
        assetIds: dedupePreservingOrder(assetIds),
        updatedAtMs: nowMs(),
      };
      await playlists.update(record);
      return record;
    },

    async deletePlaylist(ownerId: string, playlistId: string): Promise<void> {
      await loadOwnedPlaylist(ownerId, playlistId);
      await playlists.remove(playlistId);
    },

    async listPlaylists(ownerId: string): Promise<readonly PlaylistRecord[]> {
      return playlists.listByOwner(ownerId);
    },

    /** Exposed so `download-service.ts` shares the one ownership gate. */
    loadOwned,
  };

  function assertPlaylistName(name: string): void {
    if (
      typeof name !== 'string' ||
      name.length < PLAYLIST_NAME_MIN_LENGTH ||
      name.length > PLAYLIST_NAME_MAX_LENGTH
    ) {
      throw libraryPlaylistInvalid('playlist_name_length', {
        expected: `${String(PLAYLIST_NAME_MIN_LENGTH)}..${String(PLAYLIST_NAME_MAX_LENGTH)}`,
        actual: String(typeof name === 'string' ? name.length : typeof name),
      });
    }
  }

  /**
   * A playlist may only hold assets the owner owns.
   *
   * Requirement 11.10 does not say so, and it follows from 11.1: a playlist that could
   * name someone else's asset would be a listing of assets the requester does not own,
   * reached through a different door.
   */
  async function assertOwnedAssets(ownerId: string, assetIds: readonly string[]): Promise<void> {
    for (const assetId of new Set(assetIds)) {
      await loadOwned(ownerId, assetId);
    }
  }
}

/** An asset appears once, at its first position — mirrors `playlist_item_unique_asset`. */
function dedupePreservingOrder(assetIds: readonly string[]): readonly string[] {
  return [...new Set(assetIds)];
}
