import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerErrorHandler } from '../../../api/gateway/error-handler';
import {
  concurrentJobLimitReached,
  creditBalanceInsufficient,
  monthlyAssetLimitReached,
  monthlyJobLimitReached,
  pricingEntryNotFound,
  type CreditError,
} from '../../../services/credit/errors';

/**
 * Credit rejections over the one gateway error contract (Requirements 2.3, 2.6,
 * 2.11; design §2.2).
 *
 * The acceptance criteria name HTTP status codes, so what matters is that the
 * shared handler in `api/gateway/error-handler.ts` renders a `CreditError` with
 * its status, its machine-readable `code` and the payload the criterion asks for
 * — without a second code path beside the account and registry errors. The route
 * here exists only to raise the error: the real charge paths are called by
 * Job_Orchestrator, not by an HTTP client.
 */

function appThrowing(error: CreditError): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/boom', async () => {
    throw error;
  });
  return app;
}

describe('credit rejections through the gateway error contract', () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    app = null;
  });

  afterEach(async () => {
    await app?.close();
  });

  async function raise(error: CreditError) {
    app = appThrowing(error);
    const response = await app.inject({ method: 'GET', url: '/boom' });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it('renders an insufficient balance as 402 with the shortfall (Requirement 2.3)', async () => {
    const { statusCode, body } = await raise(
      creditBalanceInsufficient({ requiredCredits: 76, balance: 24 }),
    );

    expect(statusCode).toBe(402);
    expect(body.error).toMatchObject({
      code: 'credit_balance_insufficient',
      requiredCredits: 76,
      balance: 24,
      shortfallCredits: 52,
    });
  });

  it('renders the concurrency cap as 429 with the in-flight count (Requirement 2.6)', async () => {
    const { statusCode, body } = await raise(
      concurrentJobLimitReached({ jobsInFlight: 3, concurrentJobLimit: 3, planId: 'creator' }),
    );

    expect(statusCode).toBe(429);
    expect(body.error).toMatchObject({
      code: 'concurrent_job_limit_reached',
      jobsInFlight: 3,
      concurrentJobLimit: 3,
      planId: 'creator',
    });
  });

  it('renders an unpriced combination as 400 with its identifier (Requirement 2.11)', async () => {
    const { statusCode, body } = await raise(
      pricingEntryNotFound({
        assetKind: 'sfx',
        engineId: 'brand-new',
        pricingKey: 'sfx:brand-new',
      }),
    );

    expect(statusCode).toBe(400);
    expect(body.error).toMatchObject({
      code: 'pricing_entry_not_found',
      pricingKey: 'sfx:brand-new',
    });
  });

  it('renders the monthly caps as 429 with limit and usage (Requirements 2.5, 2.14)', async () => {
    const monthly = await raise(
      monthlyJobLimitReached({ planId: 'free', monthlyJobLimit: 30, jobsChargedThisMonth: 30 }),
    );
    expect(monthly.statusCode).toBe(429);
    expect(monthly.body.error).toMatchObject({
      code: 'monthly_job_limit_reached',
      monthlyJobLimit: 30,
    });
    await app?.close();

    const perKind = await raise(
      monthlyAssetLimitReached({
        planId: 'free',
        assetKind: 'song',
        monthlyAssetLimit: 10,
        outputsThisMonth: 10,
        requestedOutputs: 1,
      }),
    );
    expect(perKind.statusCode).toBe(429);
    expect(perKind.body.error).toMatchObject({
      code: 'monthly_asset_limit_reached',
      assetKind: 'song',
      monthlyAssetLimit: 10,
    });
  });

  it('never leaks a stack trace or an unmapped 500', async () => {
    const { body } = await raise(creditBalanceInsufficient({ requiredCredits: 5, balance: 0 }));

    expect(Object.keys(body)).toEqual(['error']);
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});
