import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import { encodeLibraryCursor, decodeLibraryCursor } from '../../../domain/library/cursor-codec';
import type { AssetKind } from '../../../domain/asset-kind';
import type { LibrarySortKey } from '../../../domain/library/bounds';
import type { createLibraryService } from '../../../services/library/library-service';
import { requireAccount } from '../authentication';
import {
  createPlaylistSchema,
  deleteAssetSchema,
  deletePlaylistSchema,
  listAssetsSchema,
  listPlaylistsSchema,
  listSoundPackAssetsSchema,
  renameAssetSchema,
  restoreAssetSchema,
  setAssetTagsSchema,
  setPlaylistAssetsSchema,
} from '../schemas/library-schemas';

/**
 * Library routes (Requirements 11.1–11.13).
 *
 * Thin, like every route file here: each one resolves the caller, calls one service method and
 * renders the result. Requirement 11.9's 403 and 11.1's owner scope are both the service's —
 * `loadOwned` is the single gate — so no route re-checks ownership, and none can forget to.
 *
 * ### The cursor is translated here and nowhere else
 *
 * `LibraryCursor` is a triple and the wire carries one opaque string, so this layer encodes on
 * the way out and decodes on the way in (`domain/library/cursor-codec.ts`). A cursor that
 * cannot be read decodes to `null`, which the service already means by "the first page"; a
 * cursor that reads but names another sort key is refused by the service, because that one
 * means the client changed the order and kept the cursor.
 *
 * ### Sound-pack listing takes no owner, and that is the requirement
 *
 * Requirement 11.13 lists a pack's cues by pack id. The service does not scope it to an owner
 * and neither does this; the route is still behind authentication, so it is not open, but a
 * pack is addressable by anyone signed in. That follows the service, which is where the rule
 * would change if it should.
 */
export interface LibraryRouteOptions {
  readonly library: ReturnType<typeof createLibraryService>;
  readonly authenticate: preHandlerHookHandler;
}

interface ListQuery {
  readonly pageSize?: number;
  readonly sortKey?: LibrarySortKey;
  readonly assetKind?: AssetKind;
  readonly search?: string;
  readonly cursor?: string;
}

export function registerLibraryRoutes(app: FastifyInstance, options: LibraryRouteOptions): void {
  const { library } = options;
  const preHandler = options.authenticate;

  // Requirements 11.1–11.4, 11.7, 11.12.
  app.get<{ Querystring: ListQuery }>(
    '/library/assets',
    { schema: listAssetsSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      const query = request.query;
      const page = await library.list({
        ownerId: account.accountId,
        ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
        ...(query.sortKey === undefined ? {} : { sortKey: query.sortKey }),
        ...(query.assetKind === undefined ? {} : { assetKind: query.assetKind }),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.cursor === undefined ? {} : { cursor: decodeLibraryCursor(query.cursor) }),
      });

      return {
        assets: page.assets,
        ...(page.nextCursor === null ? {} : { nextCursor: encodeLibraryCursor(page.nextCursor) }),
      };
    },
  );

  // Requirement 11.5.
  app.patch<{ Params: { assetId: string }; Body: { name: string } }>(
    '/library/assets/:assetId',
    { schema: renameAssetSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      return library.rename(account.accountId, request.params.assetId, request.body.name);
    },
  );

  // Requirement 11.3.
  app.put<{ Params: { assetId: string }; Body: { tags: readonly string[] } }>(
    '/library/assets/:assetId/tags',
    { schema: setAssetTagsSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      return library.setTags(account.accountId, request.params.assetId, request.body.tags);
    },
  );

  // Requirement 11.6. The asset is marked, not removed; 11.8's sweep is what removes it.
  app.delete<{ Params: { assetId: string } }>(
    '/library/assets/:assetId',
    { schema: deleteAssetSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      return library.softDelete(account.accountId, request.params.assetId);
    },
  );

  // Requirement 11.11 names restore among the operations every kind must support.
  app.post<{ Params: { assetId: string } }>(
    '/library/assets/:assetId/restore',
    { schema: restoreAssetSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      return library.restore(account.accountId, request.params.assetId);
    },
  );

  // Requirement 11.13.
  app.get<{ Params: { packId: string } }>(
    '/library/sound-packs/:packId/assets',
    { schema: listSoundPackAssetsSchema, preHandler },
    async (request) => {
      requireAccount(request);
      return { assets: await library.listSoundPack(request.params.packId) };
    },
  );

  // Requirement 11.10.
  app.get(
    '/library/playlists',
    { schema: listPlaylistsSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      return { playlists: await library.listPlaylists(account.accountId) };
    },
  );

  app.post<{ Body: { name: string; assetIds: readonly string[] } }>(
    '/library/playlists',
    { schema: createPlaylistSchema, preHandler },
    async (request, reply) => {
      const account = requireAccount(request);
      const created = await library.createPlaylist(
        account.accountId,
        request.body.name,
        request.body.assetIds,
      );
      return reply.code(201).send(created);
    },
  );

  app.put<{ Params: { playlistId: string }; Body: { assetIds: readonly string[] } }>(
    '/library/playlists/:playlistId/assets',
    { schema: setPlaylistAssetsSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      return library.setPlaylistAssets(
        account.accountId,
        request.params.playlistId,
        request.body.assetIds,
      );
    },
  );

  app.delete<{ Params: { playlistId: string } }>(
    '/library/playlists/:playlistId',
    { schema: deletePlaylistSchema, preHandler },
    async (request, reply) => {
      const account = requireAccount(request);
      await library.deletePlaylist(account.accountId, request.params.playlistId);
      return reply.code(204).send();
    },
  );
}
