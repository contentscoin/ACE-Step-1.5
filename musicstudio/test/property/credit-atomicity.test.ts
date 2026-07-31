import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { findPlan, STUDIO_PLAN_ID } from '../../domain/credit/plan';
import { createInMemoryAccountPlanStore } from '../../services/credit/account-plan-store';
import { createRedisCreditBalanceStore } from '../../services/credit/adapters/redis-balance-store';
import {
  balanceKey,
  CREDIT_KEY_PREFIX,
} from '../../services/credit/adapters/redis-credit-commands';
import type { CreditBalanceStore } from '../../services/credit/balance-store';
import { createCreditService } from '../../services/credit/credit-service';
import { isCreditError } from '../../services/credit/errors';
import { createInMemoryCreditLedger } from '../../services/credit/ledger';
import { createCreditHarness } from '../support/credit-harness';
import { createFakeCreditRedis } from '../support/fake-credit-redis';

/**
 * Credit deduction atomicity under concurrency (Requirements 2.3, 2.5, 2.6).
 *
 * **Validates: Requirements 2.3, 2.6**
 *
 * These are not the round-trip properties of design §10; they pin the invariant
 * that makes Requirement 2.3 meaningful at all:
 *
 * > However concurrent requests interleave, the balance never goes negative and
 * > the credits deducted equal exactly the credits the successful charges claim.
 *
 * The concurrency is real rather than simulated. Every store call goes through
 * the scripted Redis double, whose `eval` yields to the microtask queue before
 * its critical section (the round trip) and then runs the guard and the mutation
 * with no `await` between them (Redis executing a script to completion). A
 * read-modify-write deduction would overdraw here exactly as it would against a
 * real Redis, so a passing run is evidence about the design and not about the
 * double.
 */

const STUDIO_PLAN = findPlan(STUDIO_PLAN_ID);
if (STUDIO_PLAN === undefined) throw new Error('studio plan missing');

const ACCOUNT = 'account-under-load';
const ENGINE = 'ace-step-1.5';

/** One `song` job of this length: 8 base + 1 credit per second, rounded up. */
function songCost(durationMs: number): number {
  return 8 + Math.ceil(durationMs / 1_000);
}

type Attempt = { readonly ok: true; readonly amount: number } | { readonly ok: false; readonly code: string };

const arbRun = fc.record({
  openingBalance: fc.integer({ min: 0, max: 300 }),
  // At most the studio concurrency ceiling, so a rejection here is always the
  // balance guard rather than Requirement 2.6.
  durationsMs: fc.array(fc.integer({ min: 0, max: 60_000 }), {
    minLength: 2,
    maxLength: STUDIO_PLAN.maxConcurrentJobs,
  }),
});

type Run = { readonly openingBalance: number; readonly durationsMs: readonly number[] };

/** Fires every charge at once and waits for all of them to settle. */
async function chargeConcurrently(run: Run) {
  const harness = createCreditHarness();
  await harness.accountPlans.assign(ACCOUNT, STUDIO_PLAN_ID);
  await harness.balances.initialise(ACCOUNT, run.openingBalance);

  const attempts: Promise<Attempt>[] = run.durationsMs.map((durationMs, index) =>
    harness.service
      .chargeGeneration({
        accountId: ACCOUNT,
        jobId: `job-${index}`,
        assetKind: 'song',
        engineId: ENGINE,
        durationMs,
        outputCount: 1,
      })
      .then(
        (charge): Attempt => ({ ok: true, amount: charge.amount }),
        (error: unknown): Attempt => {
          if (!isCreditError(error)) throw error;
          return { ok: false, code: error.code };
        },
      ),
  );

  const outcomes = await Promise.all(attempts);
  const deducted = outcomes.reduce(
    (total, outcome) => total + (outcome.ok ? outcome.amount : 0),
    0,
  );

  return { harness, outcomes, deducted };
}

describe('concurrent credit deduction (Requirement 2.3)', () => {
  it('never leaves the balance negative', async () => {
    await fc.assert(
      fc.asyncProperty(arbRun, async (run) => {
        const { harness } = await chargeConcurrently(run);

        expect(await harness.balances.balanceOf(ACCOUNT)).toBeGreaterThanOrEqual(0);
        return true;
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it('deducts exactly what the successful charges claim, and no more than was available', async () => {
    await fc.assert(
      fc.asyncProperty(arbRun, async (run) => {
        const { harness, deducted } = await chargeConcurrently(run);

        expect(deducted).toBeLessThanOrEqual(run.openingBalance);
        expect(await harness.balances.balanceOf(ACCOUNT)).toBe(run.openingBalance - deducted);
        return true;
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it('writes one ledger charge per success and none per rejection', async () => {
    await fc.assert(
      fc.asyncProperty(arbRun, async (run) => {
        const { harness, outcomes, deducted } = await chargeConcurrently(run);

        const entries = await harness.ledger.entriesFor(ACCOUNT);
        const charges = entries.filter((entry) => entry.entryType === 'charge');

        expect(charges).toHaveLength(outcomes.filter((outcome) => outcome.ok).length);
        expect(charges.reduce((total, entry) => total + -entry.amount, 0)).toBe(deducted);

        // A rejection is the 402 of Requirement 2.3, never a silent partial debit.
        for (const outcome of outcomes) {
          if (!outcome.ok) expect(outcome.code).toBe('credit_balance_insufficient');
        }
        return true;
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it('makes progress: a request that fits is never refused', async () => {
    await fc.assert(
      fc.asyncProperty(arbRun, async (run) => {
        const cheapest = Math.min(...run.durationsMs.map(songCost));
        const { outcomes } = await chargeConcurrently(run);

        if (run.openingBalance >= cheapest) {
          expect(outcomes.some((outcome) => outcome.ok)).toBe(true);
        } else {
          expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
        }
        return true;
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it('leaves no in-flight slot behind for a rejected request', async () => {
    await fc.assert(
      fc.asyncProperty(arbRun, async (run) => {
        const { harness, outcomes } = await chargeConcurrently(run);

        // Only the charges that succeeded hold a slot; every failure path
        // released the one it took.
        expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(
          outcomes.filter((outcome) => outcome.ok).length,
        );
        return true;
      }),
      { numRuns: 120 },
    );
  }, 120_000);
});

/**
 * Negative control.
 *
 * A property that would also hold for a broken implementation proves nothing, so
 * this pins the opposite: the *same* concurrent workload against a store whose
 * `tryDebit` reads, yields, and only then writes does overdraw. The guarantee in
 * the properties above therefore comes from the atomic guard-and-decrement and
 * not from the test harness being too gentle.
 */
describe('the atomicity guarantee is what prevents the overdraw', () => {
  const OPENING_BALANCE = 50;
  const CHARGE_COUNT = 8;
  const DURATION_MS = 1_000; // 8 base + 1 second = 9 credits per charge.

  async function chargeAll(balances: CreditBalanceStore): Promise<number> {
    const ledger = createInMemoryCreditLedger();
    const accountPlans = createInMemoryAccountPlanStore();
    await accountPlans.assign(ACCOUNT, STUDIO_PLAN_ID);
    await balances.initialise(ACCOUNT, OPENING_BALANCE);

    const service = createCreditService({ balances, ledger, accountPlans });

    await Promise.all(
      Array.from({ length: CHARGE_COUNT }, (_unused, index) =>
        service
          .chargeGeneration({
            accountId: ACCOUNT,
            jobId: `job-${index}`,
            assetKind: 'song',
            engineId: ENGINE,
            durationMs: DURATION_MS,
            outputCount: 1,
          })
          .catch((error: unknown) => {
            if (!isCreditError(error)) throw error;
          }),
      ),
    );

    return balances.balanceOf(ACCOUNT);
  }

  /**
   * Same Redis, same everything — except the debit reads the balance, yields,
   * and only then writes. That is the lost-update bug the Lua script avoids.
   */
  function readThenWriteStore(): CreditBalanceStore {
    const commands = createFakeCreditRedis();
    const atomic = createRedisCreditBalanceStore({ commands });

    return {
      ...atomic,
      async tryDebit(accountId, amount) {
        const key = balanceKey(CREDIT_KEY_PREFIX, accountId);
        const balance = Number((await commands.get(key)) ?? 0);
        if (balance < amount) return { applied: false, balance };
        return { applied: true, balance: await commands.incrby(key, -amount) };
      },
    };
  }

  it('holds with the atomic store and breaks without it', async () => {
    const atomicBalance = await chargeAll(createCreditHarness().balances);
    const racedBalance = await chargeAll(readThenWriteStore());

    expect(atomicBalance).toBeGreaterThanOrEqual(0);
    // 8 concurrent charges of 9 credits against 50: the guard was evaluated
    // against a balance that no longer existed by the time the write landed.
    expect(racedBalance).toBeLessThan(0);
  });
});

describe('concurrent job admission (Requirement 2.6)', () => {
  it('admits exactly the plan limit, no fewer and no more', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 2, max: 14 }),
        async (concurrentJobLimit, attemptCount) => {
          const harness = createCreditHarness();

          const admissions = await Promise.all(
            Array.from({ length: attemptCount }, () =>
              harness.balances
                .tryAcquireJobSlot(ACCOUNT, concurrentJobLimit)
                .then((outcome) => outcome.acquired),
            ),
          );

          const admitted = admissions.filter(Boolean).length;

          expect(admitted).toBe(Math.min(concurrentJobLimit, attemptCount));
          expect(await harness.balances.jobsInFlight(ACCOUNT)).toBe(admitted);
          return true;
        },
      ),
      { numRuns: 150 },
    );
  }, 120_000);
});
