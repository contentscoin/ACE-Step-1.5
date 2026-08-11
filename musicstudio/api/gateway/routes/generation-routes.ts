import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import { attachJobEventStream, formatSseFrame, jobEventFrame, SSE_HEADERS } from '../../sse/event-stream';
import type { Clock } from '../../../services/clock';
import type { AssetKind } from '../../../domain/asset-kind';
import type { InputModality } from '../../../adapters/normalized-generation';
import type { JobEventBusPort } from '../../../services/generation/job-events';
import type { JobOrchestrator, SubmitJobInput } from '../../../services/generation/job-orchestrator';
import { jobStatusEvent } from '../../../services/generation/job-status';
import type { JobRuntime } from '../../../services/generation/runtime';
import { requireAccount } from '../authentication';
import { presentSubmitOutcome } from '../presenters';
import {
  cancelGenerationJobSchema,
  getGenerationJobSchema,
  retryGenerationJobSchema,
  streamGenerationJobSchema,
  submitGenerationJobSchema,
} from '../schemas/generation-schemas';

/**
 * Generation_Job routes (Requirements 5.1, 5.3, 5.4, 5.5, 5.7, 6.1, 6.4, 6.6).
 *
 * Thin by construction: every route resolves the caller, calls one orchestrator
 * method and renders the result. No lifecycle decision is made at this layer, which
 * is what lets the Requirement 5 and 6 tests run against the orchestrator directly
 * and lets these tests be about HTTP.
 */
export interface GenerationRouteOptions {
  readonly orchestrator: JobOrchestrator;
  /** Shared with the orchestrator, so a stream sees exactly what it published. */
  readonly events: JobEventBusPort;
  /** Needed for the initial snapshot frame and the delivery timestamps. */
  readonly runtime: JobRuntime;
  readonly clock: Clock;
  readonly authenticate: preHandlerHookHandler;
}

interface SubmitBody {
  readonly assetKind: AssetKind;
  readonly inputModality: InputModality;
  readonly durationMs: number;
  readonly prompt?: string;
  readonly inputAssetIds?: readonly string[];
  readonly seed?: number | null;
  readonly engineId?: string;
  readonly resultCount?: number;
}

export function registerGenerationRoutes(
  app: FastifyInstance,
  options: GenerationRouteOptions,
): void {
  const { orchestrator } = options;

  // Requirement 5.1. A rejection from routing (including the Requirement 6.6
  // maintenance notice) propagates untouched to the shared error handler.
  app.post<{ Body: SubmitBody }>(
    '/generation-jobs',
    { schema: submitGenerationJobSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      const outcome = await orchestrator.submit(submitInputOf(request.body, actor.accountId));
      return presentSubmitOutcome(reply, outcome);
    },
  );

  // Requirements 5.3, 5.5, 6.1.
  app.get<{ Params: { jobId: string } }>(
    '/generation-jobs/:jobId',
    { schema: getGenerationJobSchema, preHandler: options.authenticate },
    async (request) => {
      const actor = requireAccount(request);
      return orchestrator.statusOf(request.params.jobId, actor.accountId);
    },
  );

  // Requirement 5.7.
  app.post<{ Params: { jobId: string } }>(
    '/generation-jobs/:jobId/cancel',
    { schema: cancelGenerationJobSchema, preHandler: options.authenticate },
    async (request) => {
      const actor = requireAccount(request);
      return orchestrator.cancel(request.params.jobId, actor.accountId);
    },
  );

  // Requirement 6.4.
  app.post<{ Params: { jobId: string } }>(
    '/generation-jobs/:jobId/retry',
    { schema: retryGenerationJobSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      return presentSubmitOutcome(reply, await orchestrator.retry(request.params.jobId, actor.accountId));
    },
  );

  /**
   * Requirement 5.4 — the open client connection.
   *
   * Ownership is resolved through `statusOf` *before* the response is hijacked, so
   * an unauthorised or unknown job still gets a normal JSON error rather than a
   * half-opened stream. The current state is then sent immediately, which both
   * spares the client an extra status request and makes the connection observably
   * live before any transition happens.
   */
  app.get<{ Params: { jobId: string } }>(
    '/generation-jobs/:jobId/events',
    { schema: streamGenerationJobSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      const { jobId } = request.params;
      await orchestrator.statusOf(jobId, actor.accountId);

      const record = await options.runtime.store.find(jobId);
      reply.hijack();
      for (const [name, value] of Object.entries(SSE_HEADERS)) {
        reply.raw.setHeader(name, value);
      }
      reply.raw.flushHeaders();

      const stream = attachJobEventStream({
        bus: options.events,
        accountId: actor.accountId,
        jobId,
        clock: options.clock,
        sink: {
          write: (chunk) => reply.raw.write(chunk),
          end: () => reply.raw.end(),
        },
      });

      if (record !== undefined) {
        reply.raw.write(formatSseFrame(jobEventFrame(await jobStatusEvent(options.runtime, record))));
      }

      request.raw.on('close', () => {
        stream.close();
      });
    },
  );
}


function submitInputOf(body: SubmitBody, accountId: string): SubmitJobInput {
  return {
    accountId,
    assetKind: body.assetKind,
    inputModality: body.inputModality,
    durationMs: body.durationMs,
    ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
    ...(body.inputAssetIds === undefined ? {} : { inputAssetIds: body.inputAssetIds }),
    ...(body.seed === undefined ? {} : { seed: body.seed }),
    ...(body.engineId === undefined ? {} : { engineId: body.engineId }),
    ...(body.resultCount === undefined ? {} : { resultCount: body.resultCount }),
  };
}
