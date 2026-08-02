import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';

import type { LyricsDocument } from '../../../domain/lyrics/document';
import { sectionLabelOf } from '../../../domain/lyrics/section-type';
import { describeParseError } from '../../../domain/parse-error';
import type {
  LyricsAssistant,
  LyricsAssistantFailure,
} from '../../../services/lyrics/lyrics-assistant';
import { LYRICS_CANDIDATE_CHOICES } from '../../../services/lyrics/lyrics-assistant';
import type { TimedLyricsService } from '../../../services/lyrics/timed-lyrics-service';
import { requireAccount } from '../authentication';
import {
  createLyricsDraftSchema,
  createLyricsEnrichmentSchema,
  downloadTimedLyricsSchema,
} from '../schemas/lyrics-schemas';

/**
 * Lyric enrichment, drafting and LRC download (Requirements 8.1–8.5, 10.8).
 *
 * Thin, like the song routes: resolve the caller, hand the body to Lyrics_Assistant,
 * render the outcome. All three endpoints require authentication — enrichment reaches
 * the engine and a download exposes a track's content — but **none of them touch
 * credits**, which is Requirement 8.6: there is no `CreditService` in this file's
 * dependencies, so no request handled here can charge.
 *
 * Requirement 8.5 shapes the failure body rather than only the status: the engine's
 * failure reason *and* the user's unchanged input are both returned, so a client can
 * repopulate its form from the response without having kept the request.
 */
export interface LyricsRouteOptions {
  readonly assistant: LyricsAssistant;
  /** Optional: the LRC endpoint mounts only where timings are available. */
  readonly timedLyrics?: TimedLyricsService;
  readonly authenticate: preHandlerHookHandler;
}

interface EnrichmentBody {
  readonly caption: string;
  readonly lyrics: string;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: number;
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
}

type DraftBody = Omit<EnrichmentBody, 'caption' | 'lyrics'> & { readonly topic: string };

export function registerLyricsRoutes(app: FastifyInstance, options: LyricsRouteOptions): void {
  // Requirements 8.1, 8.2, 8.5.
  app.post<{ Body: EnrichmentBody }>(
    '/lyrics/enrichments',
    { schema: createLyricsEnrichmentSchema, preHandler: options.authenticate },
    async (request, reply) => {
      requireAccount(request);
      const outcome = await options.assistant.enrich(request.body);
      if (outcome.kind === 'failed') return renderFailure(reply, outcome);

      const { proposal } = outcome;
      return reply.code(200).send({
        original: proposal.original,
        enriched: proposal.enriched,
        enrichedStructure: renderStructure(proposal.enrichedStructure),
        warnings: proposal.warnings,
        // Requirement 8.2: the response names the choices and makes none of them.
        choices: [...LYRICS_CANDIDATE_CHOICES],
      });
    },
  );

  // Requirements 8.3, 8.4.
  app.post<{ Body: DraftBody }>(
    '/lyrics/drafts',
    { schema: createLyricsDraftSchema, preHandler: options.authenticate },
    async (request, reply) => {
      requireAccount(request);
      const outcome = await options.assistant.draft(request.body);
      if (outcome.kind === 'failed') return renderFailure(reply, outcome);

      const { draft } = outcome;
      return reply.code(200).send({
        caption: draft.caption,
        lyrics: draft.lyrics,
        structure: renderStructure(draft.structure),
        bpm: draft.bpm,
        keyScale: draft.keyScale,
        timeSignature: draft.timeSignature,
        durationSeconds: draft.durationSeconds,
        vocalLanguage: draft.vocalLanguage,
        warnings: draft.warnings,
      });
    },
  );

  const { timedLyrics } = options;
  if (timedLyrics === undefined) return;

  // Requirement 10.8.
  app.get<{ Params: { trackId: string }; Querystring: { trackDurationMs: number } }>(
    '/tracks/:trackId/timed-lyrics.lrc',
    { schema: downloadTimedLyricsSchema, preHandler: options.authenticate },
    async (request, reply) => {
      requireAccount(request);
      const outcome = await timedLyrics.lrcFor({
        trackId: request.params.trackId,
        trackDurationMs: request.query.trackDurationMs,
      });

      if (outcome.kind === 'unavailable') {
        return reply.code(404).send({
          error: {
            code: 'timed_lyrics_not_found',
            message: 'This track has no Timed_Lyrics.',
          },
        });
      }

      if (outcome.kind === 'out_of_bounds') {
        // Requirement 10.7 broken by the stored timings: refused, with the offending
        // line numbers, rather than served clamped.
        return reply.code(409).send({
          error: {
            code: 'timed_lyrics_out_of_track_bounds',
            message: 'The stored Timed_Lyrics fall outside the track length.',
            violations: outcome.errors.map(describeParseError),
          },
        });
      }

      return reply
        .code(200)
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="${outcome.fileName}"`)
        .send(outcome.lrc);
    },
  );
}

/**
 * 502 for an engine failure, 422 for a draft the engine returned but that does not
 * satisfy Requirement 8.4.
 *
 * The distinction matters to a client: the first is worth retrying unchanged, the
 * second is worth retrying with a more specific topic.
 */
function renderFailure(reply: FastifyReply, failure: LyricsAssistantFailure): FastifyReply {
  const status = failure.code === 'lyrics_enrichment_engine_failed' ? 502 : 422;
  return reply.code(status).send({
    error: {
      code: failure.code,
      message: failure.reason,
      // Requirement 8.5: the caller's input, unchanged.
      original: failure.original,
    },
  });
}

/** Sections in wire form: the printed tag label, or `null` for the leading section. */
function renderStructure(
  document: LyricsDocument,
): readonly { kind: string; label: string | null; lines: readonly string[] }[] {
  return document.sections.map((section) => ({
    kind: section.type.kind,
    label: sectionLabelOf(section.type),
    lines: section.lines,
  }));
}
