import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import type { AssetKind } from '../../../domain/asset-kind';
import type { CreditService } from '../../../services/credit';
import { requireAccount } from '../authentication';
import { creditEstimateSchema, creditUsageSchema } from '../schemas/credit-schemas';

/**
 * Credit routes (Requirements 2.7, 2.9–2.11).
 *
 * Only the two read paths live here. Charging is triggered by Generation_Job
 * creation and by mixdown export, which belong to Job_Orchestrator (task 1.5) and
 * Timeline_Service; those call Credit_Service directly. Exposing a "charge me"
 * endpoint would let a client debit an account with no job to show for it.
 *
 * Both routes are behind the existing auth middleware and answer for the
 * authenticated account only — a credit balance is never addressable by id from
 * outside.
 */
export interface CreditRouteOptions {
  readonly creditService: CreditService;
  readonly authenticate: preHandlerHookHandler;
}

interface EstimateQuery {
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly durationMs: number;
  readonly outputCount?: number;
}

export function registerCreditRoutes(app: FastifyInstance, options: CreditRouteOptions): void {
  const { creditService } = options;

  // Requirement 2.7.
  app.get(
    '/credits/usage',
    { schema: creditUsageSchema, preHandler: options.authenticate },
    async (request) => {
      const account = requireAccount(request);
      return creditService.usage({ accountId: account.accountId });
    },
  );

  // Requirements 2.9, 2.10; 2.11 rejects with 400 and the combination id.
  app.get<{ Querystring: EstimateQuery }>(
    '/credits/estimate',
    { schema: creditEstimateSchema, preHandler: options.authenticate },
    async (request) => {
      const account = requireAccount(request);
      const { assetKind, engineId, durationMs } = request.query;
      const quote = creditService.quote({
        assetKind,
        engineId,
        durationMs,
        outputCount: request.query.outputCount ?? 1,
      });

      const usage = await creditService.usage({ accountId: account.accountId });
      return { ...quote, balance: usage.balance, sufficient: usage.balance >= quote.amount };
    },
  );
}
