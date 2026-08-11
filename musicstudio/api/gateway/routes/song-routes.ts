import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import type {
  CustomModeSongRequest,
  SimpleModeSongRequest,
} from '../../../domain/song/request';
import type { SongGateway } from '../../../services/generation/song-gateway';
import { requireAccount } from '../authentication';
import { presentSubmitOutcome } from '../presenters';
import { createCustomSongSchema, createSimpleSongSchema } from '../schemas/song-schemas';

/**
 * Simple_Mode and Custom_Mode song endpoints (Requirements 3, 4).
 *
 * Thin, like the generic Requirement 5 routes: resolve the caller, hand the body to
 * the `SongGateway`, render the outcome. No validation, defaulting or engine
 * knowledge lives here — a rejection is the gateway's `song_request_invalid`, which
 * the shared error handler already renders with its violation list.
 *
 * Two endpoints rather than one with a `mode` discriminator, because the two bodies
 * share almost no fields: Simple_Mode takes a description and nothing musical,
 * Custom_Mode takes the musical metadata and no description. One schema covering
 * both would accept combinations neither mode allows.
 */
export interface SongRouteOptions {
  readonly gateway: SongGateway;
  readonly authenticate: preHandlerHookHandler;
}

type SimpleBody = Omit<SimpleModeSongRequest, 'mode'> & { readonly engineId?: string };
type CustomBody = Omit<CustomModeSongRequest, 'mode'> & { readonly engineId?: string };

export function registerSongRoutes(app: FastifyInstance, options: SongRouteOptions): void {
  // Requirements 3.1–3.3, 3.5–3.8.
  app.post<{ Body: SimpleBody }>(
    '/songs/simple',
    { schema: createSimpleSongSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      const { engineId, ...body } = request.body;
      const outcome = await options.gateway.submit({
        accountId: actor.accountId,
        request: { mode: 'simple', ...body },
        ...(engineId === undefined ? {} : { engineId }),
      });
      return presentSubmitOutcome(reply, outcome);
    },
  );

  // Requirements 4.1–4.10.
  app.post<{ Body: CustomBody }>(
    '/songs/custom',
    { schema: createCustomSongSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      const { engineId, ...body } = request.body;
      const outcome = await options.gateway.submit({
        accountId: actor.accountId,
        request: { mode: 'custom', ...body },
        ...(engineId === undefined ? {} : { engineId }),
      });
      return presentSubmitOutcome(reply, outcome);
    },
  );
}
