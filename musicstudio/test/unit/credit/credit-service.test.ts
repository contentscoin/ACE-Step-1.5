import { beforeEach, describe, expect, it } from 'vitest';

import { balanceOf } from '../../../domain/credit/ledger-entry';
import { CREATOR_PLAN_ID, findPlan, FREE_PLAN_ID } from '../../../domain/credit/plan';
import { SOUND_PACK_CUE_COUNT } from '../../../domain/credit/pricing';
import { isCreditError } from '../../../services/credit/errors';
import { createCreditHarness, type CreditHarness } from '../../support/credit-harness';

/**
 * Credit_Service behaviour: Requirements 2.1–2.14.
 *
 * Every assertion runs against the real Redis store adapter over the scripted
 * fake (see `test/support/fake-credit-redis.ts`), so the atomic operations under
 * test are the ones production calls.
 */

const ACCOUNT = 'account-1';
const SONG_ENGINE = 'ace-step-1.5';
const SFX_ENGINE = 'woosh-flow';
const FREE_PLAN = findPlan(FREE_PLAN_ID);
if (FREE_PLAN === undefined) throw new Error('free plan missing');

/** The error a rejection carries, or a failure if the call unexpectedly passed. */
async function rejection(attempt: Promise<unknown>): Promise<{
  statusCode: number;
  code: string;
  details: Record<string, unknown>;
}> {
  try {
    await attempt;
  } catch (error) {
    if (!isCreditError(error)) throw error;
    return { statusCode: error.statusCode, code: error.code, details: { ...error.details } };
  }
  throw new Error('expected the request to be rejected');
}

describe('Credit_Service', () => {
  let harness: CreditHarness;

  beforeEach(async () => {
    harness = createCreditHarness();
  });

  describe('account provisioning (Requirement 2.1)', () => {
    it('grants the free plan opening credits and audits the change', async () => {
      const granted = await harness.service.provisionAccount({ accountId: ACCOUNT });

      expect(granted).toMatchObject({
        planId: FREE_PLAN_ID,
        amount: FREE_PLAN.initialCredits,
        balance: FREE_PLAN.initialCredits,
        newlyGranted: true,
      });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
      expect(harness.audit.drafts.at(-1)).toMatchObject({
        eventType: 'credit_changed',
        actorId: ACCOUNT,
        beforeValue: { balance: 0 },
        afterValue: { balance: FREE_PLAN.initialCredits, change: 'initial_grant' },
      });
    });

    it('is once-only, so a retried signup cannot double the balance', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
      const again = await harness.service.provisionAccount({ accountId: ACCOUNT });

      expect(again).toMatchObject({ newlyGranted: false, amount: 0 });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
    });

    it('never records a grant it did not actually add', async () => {
      // An account that already holds an operational balance, but whose ledger
      // carries no opening grant — reachable whenever the ledger and Redis are
      // restored independently. The grant is declined by the store, so recording
      // one would leave the ledger fold disagreeing with the balance, which is
      // exactly what `account_credit_balance_violation` reports as a violation.
      await harness.balances.initialise(ACCOUNT, 500);

      const granted = await harness.service.provisionAccount({ accountId: ACCOUNT });

      expect(granted).toMatchObject({ newlyGranted: false, amount: 0, balance: 500 });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(500);
      expect(await harness.ledger.entriesFor(ACCOUNT)).toEqual([]);
      expect(harness.audit.drafts).toEqual([]);
    });
  });

  describe('charging a Generation_Job (Requirements 2.2, 2.10)', () => {
    beforeEach(async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
    });

    it('deducts for batch_size and duration, and audits the deduction', async () => {
      const charge = await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 30_000,
        outputCount: 2,
      });

      // song:ace-step-1.5 = 8 base + 1/s -> (8 + 30) x 2 outputs.
      expect(charge.amount).toBe(76);
      expect(charge.pricingKey).toBe('song:ace-step-1.5');
      expect(charge.balanceAfter).toBe(FREE_PLAN.initialCredits - 76);
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(charge.balanceAfter);

      expect(harness.audit.drafts.at(-1)).toMatchObject({
        eventType: 'credit_changed',
        actorId: ACCOUNT,
        targetId: 'job-1',
        beforeValue: { balance: FREE_PLAN.initialCredits },
        afterValue: { balance: 24, change: 'charge', delta: -76, outputCount: 2 },
      });
    });

    it('charges more for a longer request and for more outputs', async () => {
      const short = harness.service.quote({
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 10_000,
        outputCount: 1,
      });
      const long = harness.service.quote({
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 120_000,
        outputCount: 1,
      });
      const batched = harness.service.quote({
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 10_000,
        outputCount: 4,
      });

      expect(long.amount).toBeGreaterThan(short.amount);
      expect(batched.amount).toBe(short.amount * 4);
    });

    it('charges a repeated jobId once (double-submit)', async () => {
      // A plan that admits two simultaneous jobs, so the repeat reaches the
      // ledger's uniqueness guard instead of being stopped by Requirement 2.6.
      const submit = () =>
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          planId: CREATOR_PLAN_ID,
          jobId: 'job-1',
          assetKind: 'song',
          engineId: SONG_ENGINE,
          durationMs: 10_000,
          outputCount: 1,
        });

      const first = await submit();
      const repeat = await submit();

      expect(repeat).toMatchObject({ newlyCharged: false, amount: first.amount });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(first.balanceAfter);
      expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(1);
    });
  });

  describe('insufficient balance (Requirement 2.3)', () => {
    it('answers 402 with the shortfall and leaves the balance untouched', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 30_000,
        outputCount: 2,
      });
      await harness.service.settleJob({ accountId: ACCOUNT, jobId: 'job-1' });

      const failed = await rejection(
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          jobId: 'job-2',
          assetKind: 'song',
          engineId: SONG_ENGINE,
          durationMs: 30_000,
          outputCount: 2,
        }),
      );

      expect(failed.statusCode).toBe(402);
      expect(failed.code).toBe('credit_balance_insufficient');
      expect(failed.details).toMatchObject({
        requiredCredits: 76,
        balance: 24,
        shortfallCredits: 52,
      });

      // Nothing moved, and no phantom job is left in flight.
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(24);
      expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(0);
      expect(await harness.ledger.findByJob('job-2', 'charge')).toBeUndefined();
    });
  });

  describe('refunding a failed job (Requirement 2.4)', () => {
    beforeEach(async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
    });

    it('returns the full amount, audits it and frees the concurrency slot', async () => {
      const charge = await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 60_000,
        outputCount: 1,
      });

      const refund = await harness.service.refundJob({
        accountId: ACCOUNT,
        jobId: 'job-1',
        reason: 'engine_failed',
      });

      expect(refund).toMatchObject({ amount: charge.amount, newlyRefunded: true });
      expect(refund.balanceAfter).toBe(FREE_PLAN.initialCredits);
      expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(0);
      expect(harness.audit.drafts.at(-1)).toMatchObject({
        eventType: 'credit_changed',
        targetId: 'job-1',
        afterValue: { change: 'refund', delta: charge.amount, reason: 'engine_failed' },
      });
    });

    it('is idempotent, so a repeated failure callback refunds once', async () => {
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 60_000,
        outputCount: 1,
      });
      await harness.service.refundJob({ accountId: ACCOUNT, jobId: 'job-1', reason: 'failed' });
      const again = await harness.service.refundJob({
        accountId: ACCOUNT,
        jobId: 'job-1',
        reason: 'failed',
      });

      expect(again.newlyRefunded).toBe(false);
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
    });

    it('does not free a second slot when a refunded job is also settled', async () => {
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        planId: CREATOR_PLAN_ID,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 0,
        outputCount: 1,
      });
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        planId: CREATOR_PLAN_ID,
        jobId: 'job-2',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 0,
        outputCount: 1,
      });

      await harness.service.refundJob({ accountId: ACCOUNT, jobId: 'job-1', reason: 'failed' });
      // A stray settle callback for the same job must not release job-2's slot.
      await harness.service.settleJob({ accountId: ACCOUNT, jobId: 'job-1' });
      await harness.service.settleJob({ accountId: ACCOUNT, jobId: 'never-charged' });

      expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(1);
    });

    it('refunds nothing for a job that was never charged', async () => {
      const refund = await harness.service.refundJob({
        accountId: ACCOUNT,
        jobId: 'never-charged',
        reason: 'failed',
      });

      expect(refund).toMatchObject({ amount: 0, newlyRefunded: false });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
    });

    it('satisfies CreditRefundPort, so the registry timeout refund shares this path', async () => {
      const charge = await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 60_000,
        outputCount: 1,
      });

      // Requirement 20.15 reaches Credit_Service through this narrow port.
      await harness.service.refund({
        accountId: ACCOUNT,
        jobId: 'job-1',
        engineId: SONG_ENGINE,
        reason: 'engine_timeout',
        amount: charge.amount,
        refundDeadlineMs: harness.clock.now().getTime() + 60_000,
      });

      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
    });

    it('exposes the pricing port the registry already depends on', () => {
      expect(harness.service.missingPricingKeys('ace-step-1.5', ['song', 'bgm'])).toEqual([]);
      expect(harness.service.missingPricingKeys('brand-new', ['song'])).toEqual(['song:brand-new']);
    });
  });

  describe('plan quotas (Requirements 2.5, 2.6, 2.14)', () => {
    beforeEach(async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
    });

    it('answers 429 with the in-flight count when the concurrency cap is reached', async () => {
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 10_000,
        outputCount: 1,
      });
      const balanceAfterFirst = await harness.balances.balanceOf(ACCOUNT);

      const rejected = await rejection(
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          jobId: 'job-2',
          assetKind: 'song',
          engineId: SONG_ENGINE,
          durationMs: 10_000,
          outputCount: 1,
        }),
      );

      expect(rejected.statusCode).toBe(429);
      expect(rejected.code).toBe('concurrent_job_limit_reached');
      expect(rejected.details).toMatchObject({
        jobsInFlight: FREE_PLAN.maxConcurrentJobs,
        concurrentJobLimit: FREE_PLAN.maxConcurrentJobs,
        planId: FREE_PLAN_ID,
      });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(balanceAfterFirst);

      // Settling the first job admits the next one.
      await harness.service.settleJob({ accountId: ACCOUNT, jobId: 'job-1' });
      await expect(
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          jobId: 'job-2',
          assetKind: 'song',
          engineId: SONG_ENGINE,
          durationMs: 10_000,
          outputCount: 1,
        }),
      ).resolves.toMatchObject({ newlyCharged: true });
    });

    it('answers 429 when a request would pass the per-Asset_Kind monthly cap', async () => {
      const cap = FREE_PLAN.maxMonthlyAssetsByKind.song;

      const rejected = await rejection(
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          jobId: 'job-big',
          assetKind: 'song',
          engineId: SONG_ENGINE,
          durationMs: 0,
          outputCount: cap + 1,
        }),
      );

      expect(rejected.statusCode).toBe(429);
      expect(rejected.code).toBe('monthly_asset_limit_reached');
      expect(rejected.details).toMatchObject({
        assetKind: 'song',
        monthlyAssetLimit: cap,
        outputsThisMonth: 0,
        requestedOutputs: cap + 1,
      });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
    });

    it('answers 429 when the monthly Generation_Job cap is reached', async () => {
      // Cheapest kinds at zero length, spread so no per-kind cap is hit first.
      const plan = [
        { assetKind: 'dialogue' as const, engineId: 'tts-engine-a', count: 10 },
        { assetKind: 'sfx' as const, engineId: SFX_ENGINE, count: 20 },
      ];

      let jobNumber = 0;
      for (const step of plan) {
        for (let index = 0; index < step.count; index += 1) {
          jobNumber += 1;
          const jobId = `job-${jobNumber}`;
          await harness.service.chargeGeneration({
            accountId: ACCOUNT,
            jobId,
            assetKind: step.assetKind,
            engineId: step.engineId,
            durationMs: 0,
            outputCount: 1,
          });
          await harness.service.settleJob({ accountId: ACCOUNT, jobId });
        }
      }

      expect(jobNumber).toBe(FREE_PLAN.maxJobsPerMonth);

      const rejected = await rejection(
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          jobId: 'job-over',
          assetKind: 'song',
          engineId: SONG_ENGINE,
          durationMs: 0,
          outputCount: 1,
        }),
      );

      expect(rejected.statusCode).toBe(429);
      expect(rejected.code).toBe('monthly_job_limit_reached');
      expect(rejected.details).toMatchObject({
        monthlyJobLimit: FREE_PLAN.maxJobsPerMonth,
        jobsChargedThisMonth: FREE_PLAN.maxJobsPerMonth,
      });
    });

    it('frees a monthly job slot again when the job is refunded', async () => {
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 0,
        outputCount: 1,
      });
      const before = await harness.service.usage({ accountId: ACCOUNT });

      await harness.service.refundJob({ accountId: ACCOUNT, jobId: 'job-1', reason: 'failed' });
      const after = await harness.service.usage({ accountId: ACCOUNT });

      expect(before.creditsUsedThisMonth).toBe(8);
      expect(after.creditsUsedThisMonth).toBe(0);
      expect(after.remainingMonthlyJobs).toBe(FREE_PLAN.maxJobsPerMonth);
      expect(after.remainingMonthlyAssetsByKind.song).toBe(FREE_PLAN.maxMonthlyAssetsByKind.song);
    });
  });

  describe('unregistered combination (Requirement 2.11)', () => {
    it('answers 400 with the missing combination identifier', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });

      const rejected = await rejection(
        harness.service.chargeGeneration({
          accountId: ACCOUNT,
          jobId: 'job-1',
          assetKind: 'song',
          engineId: 'unregistered-engine',
          durationMs: 10_000,
          outputCount: 1,
        }),
      );

      expect(rejected.statusCode).toBe(400);
      expect(rejected.code).toBe('pricing_entry_not_found');
      expect(rejected.details).toMatchObject({
        pricingKey: 'song:unregistered-engine',
        assetKind: 'song',
        engineId: 'unregistered-engine',
      });
      expect(await harness.balances.balanceOf(ACCOUNT)).toBe(FREE_PLAN.initialCredits);
      expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(0);
    });
  });

  describe('usage query (Requirement 2.7)', () => {
    it('returns balance, month-to-date credits and remaining monthly jobs', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'bgm',
        engineId: SONG_ENGINE,
        durationMs: 20_000,
        outputCount: 1,
      });

      const usage = await harness.service.usage({ accountId: ACCOUNT });

      // bgm = 4 base + 20s -> 24 credits.
      expect(usage).toMatchObject({
        accountId: ACCOUNT,
        planId: FREE_PLAN_ID,
        balance: FREE_PLAN.initialCredits - 24,
        creditsUsedThisMonth: 24,
        remainingMonthlyJobs: FREE_PLAN.maxJobsPerMonth - 1,
        monthlyJobLimit: FREE_PLAN.maxJobsPerMonth,
        jobsInFlight: 1,
        concurrentJobLimit: FREE_PLAN.maxConcurrentJobs,
      });
      expect(usage.remainingMonthlyAssetsByKind.bgm).toBe(
        FREE_PLAN.maxMonthlyAssetsByKind.bgm - 1,
      );
    });
  });

  describe('billing cycle renewal (Requirement 2.8)', () => {
    it('adds the monthly credits and zeroes the monthly aggregate', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });
      await harness.service.chargeGeneration({
        accountId: ACCOUNT,
        jobId: 'job-1',
        assetKind: 'song',
        engineId: SONG_ENGINE,
        durationMs: 30_000,
        outputCount: 1,
      });
      await harness.service.settleJob({ accountId: ACCOUNT, jobId: 'job-1' });

      const spent = await harness.service.usage({ accountId: ACCOUNT });
      expect(spent.creditsUsedThisMonth).toBe(38);

      harness.clock.set(new Date('2025-04-01T00:00:00.000Z'));
      const renewed = await harness.service.renewBillingCycle({ accountId: ACCOUNT });

      expect(renewed.amount).toBe(FREE_PLAN.monthlyCredits);
      expect(renewed.balance).toBe(spent.balance + FREE_PLAN.monthlyCredits);

      const usage = await harness.service.usage({ accountId: ACCOUNT });
      expect(usage.creditsUsedThisMonth).toBe(0);
      expect(usage.remainingMonthlyJobs).toBe(FREE_PLAN.maxJobsPerMonth);
      expect(usage.remainingMonthlyAssetsByKind.song).toBe(
        FREE_PLAN.maxMonthlyAssetsByKind.song,
      );

      // The history is intact: nothing was deleted to reset the aggregate.
      const entries = await harness.ledger.entriesFor(ACCOUNT);
      expect(entries.map((entry) => entry.entryType)).toEqual([
        'initial_grant',
        'charge',
        'cycle_renewal',
      ]);
      expect(balanceOf(entries)).toBe(usage.balance);
    });
  });

  describe('mixdown export (Requirement 2.12)', () => {
    it('charges the mixdown entry by render duration', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT });

      const short = await harness.service.chargeMixdown({
        accountId: ACCOUNT,
        jobId: 'mix-1',
        renderDurationMs: 10_000,
      });
      await harness.service.settleJob({ accountId: ACCOUNT, jobId: 'mix-1' });
      const long = await harness.service.chargeMixdown({
        accountId: ACCOUNT,
        jobId: 'mix-2',
        renderDurationMs: 40_000,
      });

      // mix = 2 base + 1/s.
      expect(short.amount).toBe(12);
      expect(long.amount).toBe(42);
      expect(short).toMatchObject({ chargeKind: 'mixdown', assetKind: 'mix', outputCount: 1 });
    });
  });

  describe('Sound_Pack generation (Requirement 2.13)', () => {
    it('charges all 78 cues as a single deduction record', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT, planId: CREATOR_PLAN_ID });

      const charge = await harness.service.chargeSoundPack({
        accountId: ACCOUNT,
        jobId: 'pack-1',
        engineId: SFX_ENGINE,
        cueDurationMs: 1_500,
      });

      // sfx:woosh-flow = 2 base + 2/s -> (2 + 3) x 78.
      expect(charge).toMatchObject({
        chargeKind: 'sound_pack',
        assetKind: 'sfx',
        outputCount: SOUND_PACK_CUE_COUNT,
        amount: 390,
      });

      const entries = await harness.ledger.entriesFor(ACCOUNT);
      const charges = entries.filter((entry) => entry.entryType === 'charge');
      expect(charges).toHaveLength(1);
      expect(charges[0]?.outputCount).toBe(SOUND_PACK_CUE_COUNT);

      // One audit record too, not 78.
      const creditEvents = harness.audit.drafts.filter(
        (draft) => (draft.afterValue as { change?: string }).change === 'charge',
      );
      expect(creditEvents).toHaveLength(1);
    });
  });

  describe('plan resolution', () => {
    it('rejects an unknown plan rather than guessing a ceiling', async () => {
      const rejected = await rejection(
        harness.service.usage({ accountId: ACCOUNT, planId: 'enterprise' }),
      );

      expect(rejected.statusCode).toBe(400);
      expect(rejected.code).toBe('plan_not_found');
    });

    it('remembers the plan an account was provisioned on', async () => {
      await harness.service.provisionAccount({ accountId: ACCOUNT, planId: CREATOR_PLAN_ID });

      const plan = await harness.service.planFor({ accountId: ACCOUNT });
      expect(plan.planId).toBe(CREATOR_PLAN_ID);
      expect((await harness.service.usage({ accountId: ACCOUNT })).planId).toBe(CREATOR_PLAN_ID);
    });
  });
});
