import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGatewayApp } from '../../api/gateway/app';
import { findPlan, FREE_PLAN_ID } from '../../domain/credit/plan';
import { createCreditHarness, type CreditHarness } from '../support/credit-harness';
import { createGatewayHarness, type GatewayHarness } from '../support/gateway-harness';

/**
 * Credit read routes over HTTP: Requirements 2.7, 2.9–2.11.
 *
 * The auth middleware from task 1.2, the JSON schemas and the single error
 * contract are all on the real request path; only Redis is faked. The gateway is
 * built directly here rather than through `createGatewayHarness`, because the
 * credit service is wired with the credit harness's own clock and store.
 */

const CREDENTIALS = { email: 'creator@example.com', password: 'correct horse battery' };
const FREE_PLAN = findPlan(FREE_PLAN_ID);
if (FREE_PLAN === undefined) throw new Error('free plan missing');

describe('credit routes end to end', () => {
  let auth: GatewayHarness;
  let credit: CreditHarness;
  let app: FastifyInstance;
  let accessToken: string;
  let accountId: string;

  beforeEach(async () => {
    auth = createGatewayHarness();
    credit = createCreditHarness();
    app = buildGatewayApp({
      accountService: auth.accountService,
      clock: auth.clock,
      creditService: credit.service,
    });

    await app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: CREDENTIALS,
    });
    accessToken = loggedIn.json().accessToken;
    accountId = loggedIn.json().accountId;

    // Requirement 2.1 — Job_Orchestrator-independent provisioning step that the
    // Account_Service will call on signup (see the integration note below).
    await credit.service.provisionAccount({ accountId });
  });

  afterEach(async () => {
    await app.close();
    await auth.close();
  });

  function get(url: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${accessToken}` } });
  }

  it('returns balance, month-to-date credits and remaining jobs (Requirement 2.7)', async () => {
    await credit.service.chargeGeneration({
      accountId,
      jobId: 'job-1',
      assetKind: 'song',
      engineId: 'ace-step-1.5',
      durationMs: 30_000,
      outputCount: 1,
    });

    const response = await get('/v1/credits/usage');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId,
      planId: FREE_PLAN_ID,
      balance: FREE_PLAN.initialCredits - 38,
      creditsUsedThisMonth: 38,
      remainingMonthlyJobs: FREE_PLAN.maxJobsPerMonth - 1,
      monthlyJobLimit: FREE_PLAN.maxJobsPerMonth,
      jobsInFlight: 1,
      concurrentJobLimit: FREE_PLAN.maxConcurrentJobs,
    });
    expect(response.json().remainingMonthlyAssetsByKind.song).toBe(
      FREE_PLAN.maxMonthlyAssetsByKind.song - 1,
    );
  });

  it('answers a price estimate for a registered combination (Requirements 2.9, 2.10)', async () => {
    const response = await get(
      '/v1/credits/estimate?assetKind=song&engineId=ace-step-1.5&durationMs=60000&outputCount=2',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pricingKey: 'song:ace-step-1.5',
      amount: 136,
      outputCount: 2,
      balance: FREE_PLAN.initialCredits,
      sufficient: false,
    });
  });

  it('rejects an unregistered combination with 400 and its identifier (Requirement 2.11)', async () => {
    const response = await get(
      '/v1/credits/estimate?assetKind=song&engineId=brand-new&durationMs=1000',
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'pricing_entry_not_found',
      pricingKey: 'song:brand-new',
      engineId: 'brand-new',
    });
  });

  it('rejects an unknown Asset_Kind at the schema edge', async () => {
    const response = await get(
      '/v1/credits/estimate?assetKind=podcast&engineId=ace-step-1.5&durationMs=1000',
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
  });

  it('reflects a refund in the usage query (Requirement 2.4)', async () => {
    await credit.service.chargeGeneration({
      accountId,
      jobId: 'job-1',
      assetKind: 'song',
      engineId: 'ace-step-1.5',
      durationMs: 30_000,
      outputCount: 1,
    });
    await credit.service.refundJob({ accountId, jobId: 'job-1', reason: 'engine_failed' });

    expect((await get('/v1/credits/usage')).json()).toMatchObject({
      balance: FREE_PLAN.initialCredits,
      creditsUsedThisMonth: 0,
      remainingMonthlyJobs: FREE_PLAN.maxJobsPerMonth,
      jobsInFlight: 0,
    });
  });

  it('requires authentication on every credit route', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/credits/usage' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/credits/estimate?assetKind=song&engineId=ace-step-1.5&durationMs=1000',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('never exposes another account balance', async () => {
    const other = { email: 'other@example.com', password: 'a different pass phrase' };
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload: other });
    const loggedIn = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: other });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/credits/usage',
      headers: { authorization: `Bearer ${loggedIn.json().accessToken as string}` },
    });

    // A fresh, unprovisioned account: the route answers for the caller only.
    expect(response.json()).toMatchObject({
      accountId: loggedIn.json().accountId,
      balance: 0,
    });
  });

  it('leaves the credit routes off a gateway built without them', async () => {
    const authOnly = createGatewayHarness();
    try {
      expect(
        (await authOnly.app.inject({ method: 'GET', url: '/v1/credits/usage' })).statusCode,
      ).toBe(404);
    } finally {
      await authOnly.close();
    }
  });
});
