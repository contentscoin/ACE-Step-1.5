import { Readable } from 'node:stream';

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import type { createPlaybackService } from '../../../services/playback/playback-service';
import { optionalAccountId } from '../authentication';
import { assetPositionSchema, assetWaveformSchema, streamAssetSchema } from '../schemas/library-schemas';

/**
 * Playback routes (Requirements 12.1–12.4, 12.6–12.9).
 *
 * ### These routes authenticate, but do not require an account
 *
 * Requirement 12.6 gates a *private* asset, which means a public one is playable by someone who
 * is not signed in — a shared link is a link, and a listener who has to register first has not
 * been shared anything. So the caller is resolved when a credential is present and left `null`
 * when it is not, and the service decides: it admits the owner, admits anything publicly
 * visible, and refuses the rest. A `preHandler` that demanded a token would make Requirement
 * 14.3's public page impossible to serve.
 *
 * A bad token is still a bad token: `optionalAccountId` rejects it rather than treating it as
 * absence, because a client sending an expired token wants to know that, not to be quietly
 * demoted to anonymous and told the asset is private.
 *
 * ### The stream is handed to Fastify as a Node stream
 *
 * `AudioObjectPort.read` returns a web `ReadableStream` — the shape S3 and a CDN speak — and
 * Fastify sends Node streams, so this converts at the edge with `Readable.fromWeb`. No schema
 * is attached to the response: a serialiser on an audio body would try to render it as JSON.
 * The headers are the ones `planRangeResponse` computed, including `content-range` on a 206 and
 * `accept-ranges` on both, so seeking works without this file knowing what a range is.
 */
export interface PlaybackRouteOptions {
  readonly playback: ReturnType<typeof createPlaybackService>;
  /** Verifies a token when one is present; the routes themselves are open. */
  readonly authenticateOptional: preHandlerHookHandler;
}

export function registerPlaybackRoutes(app: FastifyInstance, options: PlaybackRouteOptions): void {
  const { playback } = options;
  const preHandler = options.authenticateOptional;

  // Requirements 12.1, 12.2, 12.3, 12.4, 12.6, 12.8.
  app.get<{ Params: { assetId: string } }>(
    '/playback/assets/:assetId/stream',
    { schema: streamAssetSchema, preHandler },
    async (request, reply) => {
      const result = await playback.stream({
        assetId: request.params.assetId,
        requesterId: optionalAccountId(request),
        rangeHeader: request.headers.range ?? null,
      });

      // Requirement 12.4's counter is reported alongside the audio so a client can show it
      // without a second request; it is a header because the body is the audio.
      if (result.playCount !== null) {
        reply.header('x-play-count', String(result.playCount));
      }
      return reply
        .code(result.status)
        .headers(result.headers)
        .send(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]));
    },
  );

  // Requirements 12.7, 12.8.
  app.get<{ Params: { assetId: string }; Querystring: { buckets?: number } }>(
    '/playback/assets/:assetId/waveform',
    { schema: assetWaveformSchema, preHandler },
    async (request) => {
      const { buckets } = request.query;
      return playback.waveform(
        request.params.assetId,
        optionalAccountId(request),
        buckets,
      );
    },
  );

  // Requirement 12.9: where an elapsed time lands, wrapping for a loop asset.
  app.get<{ Params: { assetId: string }; Querystring: { elapsedMs: number } }>(
    '/playback/assets/:assetId/position',
    { schema: assetPositionSchema, preHandler },
    async (request) => {
      return playback.positionAfter(
        request.params.assetId,
        optionalAccountId(request),
        request.query.elapsedMs,
      );
    },
  );
}
