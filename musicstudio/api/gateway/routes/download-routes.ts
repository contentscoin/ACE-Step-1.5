import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import type { DownloadFormat } from '../../../domain/library/download';
import type { UsagePurpose } from '../../../domain/licensing/usage-purpose';
import type { createDownloadService } from '../../../services/library/download-service';
import { requireAccount } from '../authentication';
import {
  downloadAssetSchema,
  downloadFormatsSchema,
  downloadStemsSchema,
} from '../schemas/library-schemas';

/**
 * Download routes (Requirements 13.1–13.10, 33.9, 33.19).
 *
 * ### Content-Disposition carries the name the requirement fixes
 *
 * Requirement 13.6 says the file is named `제목_식별자.확장자`, and `downloadFileName` builds
 * it. A title may hold anything a user typed, so the header uses RFC 5987's `filename*` form
 * with the name percent-encoded as UTF-8, beside an ASCII `filename` fallback for clients that
 * do not read the extended form. Sending the raw name would let a quote or a newline in a
 * title break the header — or forge a second one.
 *
 * ### The attribution file is a header, not a second body
 *
 * Requirement 33.9 attaches credits to every download. One response can carry one body and the
 * body is the audio, so the credits travel as `x-attribution-file` (the name) and
 * `x-attribution` (the text, base64 so a newline cannot break the header). A client that
 * ignores them still gets the audio; a client that honours them writes the file beside it. The
 * alternative — a ZIP of audio-plus-credits for every download — would change what 13.1 hands
 * back for every user in order to serve one obligation.
 *
 * ### The stems route can answer 409 today, and that is a fact about the data
 *
 * Requirement 13.5's archive needs `stem_split` lineage rows, which only an Edit_Task produces,
 * and no edit gateway is composed yet. The route is mounted anyway: "this asset has no stems"
 * is a correct answer about an asset, unlike a route mounted over a service that does not
 * exist. When edits are composed, this route starts returning archives with no change here.
 */
export interface DownloadRouteOptions {
  readonly downloads: ReturnType<typeof createDownloadService>;
  readonly authenticate: preHandlerHookHandler;
}

/** RFC 6266 §4.1 — an ASCII fallback beside the UTF-8 form clients should prefer. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

const CONTENT_TYPES: Readonly<Record<DownloadFormat, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
};

export function registerDownloadRoutes(app: FastifyInstance, options: DownloadRouteOptions): void {
  const { downloads } = options;
  const preHandler = options.authenticate;

  // Requirements 13.2, 13.8, 13.9 — what this asset may be downloaded as, before asking for it.
  app.get<{ Params: { assetId: string } }>(
    '/library/assets/:assetId/download/formats',
    { schema: downloadFormatsSchema, preHandler },
    async (request) => {
      const account = requireAccount(request);
      const formats = await downloads.formatsFor(account.accountId, request.params.assetId);
      return { assetId: request.params.assetId, formats };
    },
  );

  // Requirements 13.1, 13.3, 13.6, 13.7, 13.10, 33.9, 33.19.
  app.get<{
    Params: { assetId: string };
    Querystring: { format: DownloadFormat; usagePurpose?: UsagePurpose };
  }>(
    '/library/assets/:assetId/download',
    { schema: downloadAssetSchema, preHandler },
    async (request, reply) => {
      const account = requireAccount(request);
      const result = await downloads.download(
        account.accountId,
        request.params.assetId,
        request.query.format,
        request.query.usagePurpose,
      );

      reply
        .header('content-type', CONTENT_TYPES[result.format])
        .header('content-disposition', contentDisposition(result.fileName))
        .header('content-length', String(result.bytes.byteLength))
        // Requirement 13.10, reported from what the worker returned rather than assumed.
        .header('x-sample-rate', String(result.sampleRate))
        // Requirement 33.19: exactly one of two values, on every download.
        .header('x-usage-purpose', result.usagePurpose);

      if (result.attribution !== undefined) {
        reply
          .header('x-attribution-file', result.attribution.fileName)
          .header('x-attribution', Buffer.from(result.attribution.text, 'utf8').toString('base64'));
      }

      return reply.send(Buffer.from(result.bytes));
    },
  );

  // Requirement 13.5.
  app.get<{ Params: { assetId: string }; Querystring: { format: DownloadFormat } }>(
    '/library/assets/:assetId/stems/download',
    { schema: downloadStemsSchema, preHandler },
    async (request, reply) => {
      const account = requireAccount(request);
      const result = await downloads.downloadStems(
        account.accountId,
        request.params.assetId,
        request.query.format,
      );

      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', contentDisposition(result.fileName))
        .header('content-length', String(result.bytes.byteLength))
        .send(Buffer.from(result.bytes));
    },
  );
}
