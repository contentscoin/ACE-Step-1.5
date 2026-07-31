import type {
  FastifyInstance,
  FastifyReply,
  FastifySchema,
  preHandlerHookHandler,
} from 'fastify';

import type { EditRequest } from '../../../domain/edit/request';
import type {
  EditGateway,
  EditSubmissionResult,
} from '../../../services/generation/edit-gateway';
import { requireAccount } from '../authentication';
import {
  createCompleteEditSchema,
  createCoverEditSchema,
  createExtractEditSchema,
  createLegoEditSchema,
  createRepaintEditSchema,
} from '../schemas/edit-schemas';

/**
 * The five Edit_Task endpoints (Requirement 7).
 *
 * Thin, like the song routes: resolve the caller, hand the body to the `EditGateway`,
 * render the outcome. No validation, defaulting or engine knowledge here — a rejection
 * is the gateway's `edit_request_invalid` or `edit_task_unsupported`, which the shared
 * error handler already renders with its payload.
 *
 * Five endpoints rather than one with a `kind` discriminator, for the reason the song
 * routes gave: the bodies share only the source asset. Only cover has a strength, only
 * repaint has an interval, only extract and lego have a track name, and one schema
 * covering all five would accept combinations no kind allows.
 */
export interface EditRouteOptions {
  readonly gateway: EditGateway;
  readonly authenticate: preHandlerHookHandler;
}

/**
 * Fields the route consumes itself rather than passing on as part of the edit.
 *
 * `engineId` selects the engine (Requirement 20.3) and `rightsConsent` is the upload
 * declaration Requirement 16.4 needs; neither is part of what the edit *is*, so both
 * are stripped before the remainder becomes an `EditRequest`.
 */
interface EditRouteEnvelope {
  readonly engineId?: string;
  readonly rightsConsent?: { readonly holdsRights: boolean; readonly acknowledgedAtMs: number };
}

type EditRouteBody = EditRouteEnvelope & Record<string, unknown>;

export function registerEditRoutes(app: FastifyInstance, options: EditRouteOptions): void {
  register(app, options, '/edits/cover', 'cover', createCoverEditSchema);
  register(app, options, '/edits/repaint', 'repaint', createRepaintEditSchema);
  register(app, options, '/edits/extract', 'extract', createExtractEditSchema);
  register(app, options, '/edits/lego', 'lego', createLegoEditSchema);
  register(app, options, '/edits/complete', 'complete', createCompleteEditSchema);
}

function register(
  app: FastifyInstance,
  options: EditRouteOptions,
  url: string,
  kind: EditRequest['kind'],
  schema: FastifySchema,
): void {
  app.post<{ Body: EditRouteBody }>(
    url,
    { schema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      const { engineId, rightsConsent, ...body } = request.body;
      const result = await options.gateway.submit({
        accountId: actor.accountId,
        // The per-kind schema above has already fixed which fields may be present and
        // rejected everything else, so re-attaching `kind` reconstitutes exactly one
        // union member. The assertion states that; every *value* is still checked by
        // `domain/edit/validation.ts`, which is where Requirement 7's rejections come
        // from — nothing is trusted because it passed the schema.
        request: { kind, ...body } as unknown as EditRequest,
        ...(engineId === undefined ? {} : { engineId }),
        ...(rightsConsent === undefined ? {} : { rightsConsent }),
      });
      return renderResult(reply, result);
    },
  );
}

/**
 * The same three outcomes the song endpoints render, plus Requirement 7.5.
 *
 * The adjustment list rides on the 202 body rather than in a header or a separate
 * call, because 7.5 says the *response* reports the adjustment and the response to an
 * accepted edit is this one.
 */
function renderResult(reply: FastifyReply, result: EditSubmissionResult): FastifyReply {
  const { outcome, adjustments } = result;

  if (outcome.kind === 'accepted') {
    return reply.code(202).send({ ...outcome.acceptance, adjustments });
  }

  if (outcome.kind === 'failed') {
    return reply.code(422).send({
      error: {
        code: 'generation_job_failed',
        message: 'The engine did not accept the Edit_Task.',
        jobId: outcome.jobId,
        classification: outcome.failure.classification,
        retryable: outcome.failure.retryable,
        reason: outcome.failure.reason,
      },
    });
  }

  return reply.code(403).send({
    error: {
      code: 'blocked_by_moderation',
      message: 'The request was blocked by the content policy.',
      blockCodes: outcome.decision.blocks.map((block) => block.code),
      violationClasses: outcome.decision.violationClasses,
    },
  });
}
