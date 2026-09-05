import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createRedisConnection, type RedisConnection } from '../../services/account/adapters/redis-client';
import { createRedisCreditBalanceStore } from '../../services/credit/adapters/redis-balance-store';
import { balanceKey, inFlightKey } from '../../services/credit/adapters/redis-credit-commands';
import type { CreditBalanceStore } from '../../services/credit/balance-store';
import { createFakeCreditRedis } from '../support/fake-credit-redis';

/**
 * The credit store's contract, against the in-process double and a real Redis (slice S4).
 *
 * `test/unit/credit/redis-balance-store.test.ts` exercises the adapter thoroughly against
 * `createFakeCreditRedis`, which *models* Redis's guarantee that a script runs to completion
 * without interleaving. A model is a claim about the server. This file holds the same cases
 * against the server itself — through the one `RedisConnection` the composition root will open
 * — and adds the case the double cannot make: many callers debiting the same balance at once,
 * with exactly as many applied as the balance allowed and not one more. That is Requirement
 * 2.3's "never negative" as a property of the deployment rather than of a fake.
 *
 * Gated on `MUSICSTUDIO_REDIS_URL`, like the database suites on theirs. Runs in the CI
 * `database` job, which now starts a Redis beside PostgreSQL. Keys are namespaced under a
 * per-run prefix so a shared server never sees two runs collide, and are deleted afterwards.
 */

const redisUrl = process.env['MUSICSTUDIO_REDIS_URL'];

interface Fixture {
  readonly store: CreditBalanceStore;
  /** Removes every key the fixture may have written. */
  cleanup(): Promise<void>;
}

/** Account ids each case may touch; cleanup deletes their two keys and nothing else. */
const ACCOUNTS = ['acct-a', 'acct-b', 'acct-ghost', ...Array.from({ length: 4 }, (_x, i) => `acct-${String(i)}`)];

function contractFor(name: string, open: () => Promise<Fixture>) {
  describe(`CreditBalanceStore contract — ${name}`, () => {
    const fixtures: Fixture[] = [];
    afterAll(async () => {
      await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
    });
    async function fresh(): Promise<CreditBalanceStore> {
      const fixture = await open();
      fixtures.push(fixture);
      return fixture.store;
    }

    it('sets the opening balance once (Requirement 2.1)', async () => {
      const store = await fresh();
      expect(await store.initialise('acct-a', 100)).toEqual({ applied: true, balance: 100 });
      expect(await store.initialise('acct-a', 999)).toEqual({ applied: false, balance: 100 });
      expect(await store.balanceOf('acct-a')).toBe(100);
    });

    it('applies a debit that fits, allows landing on zero, refuses overdraw (2.2, 2.3)', async () => {
      const store = await fresh();
      await store.initialise('acct-a', 100);
      expect(await store.tryDebit('acct-a', 40)).toEqual({ applied: true, balance: 60 });
      expect(await store.tryDebit('acct-a', 60)).toEqual({ applied: true, balance: 0 });
      expect(await store.tryDebit('acct-a', 1)).toEqual({ applied: false, balance: 0 });
    });

    it('treats an unknown account as a zero balance rather than an error', async () => {
      const store = await fresh();
      expect(await store.tryDebit('acct-ghost', 1)).toEqual({ applied: false, balance: 0 });
      expect(await store.balanceOf('acct-ghost')).toBe(0);
    });

    it('credits and returns the new balance (2.4, 2.8)', async () => {
      const store = await fresh();
      await store.initialise('acct-b', 10);
      expect(await store.credit('acct-b', 15)).toBe(25);
      expect(await store.balanceOf('acct-b')).toBe(25);
    });

    it('admits jobs up to the cap, refuses the next, frees on release, never below zero (2.5, 2.6)', async () => {
      const store = await fresh();
      expect(await store.tryAcquireJobSlot('acct-a', 2)).toEqual({ acquired: true, jobsInFlight: 1 });
      expect(await store.tryAcquireJobSlot('acct-a', 2)).toEqual({ acquired: true, jobsInFlight: 2 });
      expect(await store.tryAcquireJobSlot('acct-a', 2)).toEqual({ acquired: false, jobsInFlight: 2 });
      expect(await store.releaseJobSlot('acct-a')).toBe(1);
      expect(await store.releaseJobSlot('acct-a')).toBe(0);
      expect(await store.releaseJobSlot('acct-a')).toBe(0);
      expect(await store.jobsInFlight('acct-a')).toBe(0);
    });

    it('keeps accounts apart', async () => {
      const store = await fresh();
      await store.initialise('acct-a', 5);
      await store.initialise('acct-b', 7);
      await store.tryDebit('acct-a', 5);
      expect(await store.balanceOf('acct-a')).toBe(0);
      expect(await store.balanceOf('acct-b')).toBe(7);
    });

    it('under concurrent debits, applies exactly as many as the balance allowed', async () => {
      // Forty callers race to debit 1 from a balance of 25. The double serialises script bodies
      // by construction; the server has to be *asked*. Either way the invariant is the same:
      // exactly 25 applied, 15 refused, balance 0 — never 24, never 26, never negative.
      const store = await fresh();
      await store.initialise('acct-a', 25);
      const outcomes = await Promise.all(Array.from({ length: 40 }, () => store.tryDebit('acct-a', 1)));
      expect(outcomes.filter((o) => o.applied)).toHaveLength(25);
      expect(outcomes.filter((o) => !o.applied)).toHaveLength(15);
      expect(await store.balanceOf('acct-a')).toBe(0);
      expect(outcomes.every((o) => o.balance >= 0)).toBe(true);
    });

    it('under concurrent slot requests, admits exactly the cap', async () => {
      const store = await fresh();
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => store.tryAcquireJobSlot('acct-b', 3)));
      expect(outcomes.filter((o) => o.acquired)).toHaveLength(3);
      expect(await store.jobsInFlight('acct-b')).toBe(3);
    });
  });
}

contractFor('in-process double', async () => {
  const store = createRedisCreditBalanceStore({ commands: createFakeCreditRedis() });
  return { store, cleanup: async () => {} };
});

if (redisUrl === undefined) {
  describe.skip('CreditBalanceStore contract — real Redis (no MUSICSTUDIO_REDIS_URL)', () => {
    it('runs in the CI database job', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const connections: RedisConnection[] = [];
  afterAll(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  });

  contractFor('real Redis', async () => {
    // One connection per fixture, opened lazily inside the case: opening it at module level
    // would connect (and fail loudly) during collection on a machine with the URL set but the
    // server down, which is the wrong moment to learn that.
    const connection = createRedisConnection(redisUrl);
    connections.push(connection);
    const prefix = `musicstudio:credit:test:${randomUUID()}`;
    const store = createRedisCreditBalanceStore({ commands: connection, keyPrefix: prefix });
    return {
      store,
      cleanup: async () => {
        for (const account of ACCOUNTS) {
          await connection.del(balanceKey(prefix, account));
          await connection.del(inFlightKey(prefix, account));
        }
      },
    };
  });
}
