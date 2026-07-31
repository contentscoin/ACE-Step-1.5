import { describe, expect, it } from 'vitest';

import {
  ATOMIC_SCRIPTS,
  TRY_ACQUIRE_SLOT_SCRIPT,
  TRY_DEBIT_SCRIPT,
} from '../../../services/credit/adapters/atomic-scripts';
import { createRedisCreditBalanceStore } from '../../../services/credit/adapters/redis-balance-store';
import {
  balanceKey,
  CREDIT_KEY_PREFIX,
  decodeGuardedReply,
  inFlightKey,
} from '../../../services/credit/adapters/redis-credit-commands';
import { createFakeCreditRedis } from '../../support/fake-credit-redis';

/**
 * The Redis-backed `CreditBalanceStore` (design §2.4).
 *
 * The adapter is exercised, not stubbed: the substitution happens one level lower
 * at the Redis command surface, so key layout, argument order and reply decoding
 * are all under test.
 */

function store(prefix?: string) {
  const redis = createFakeCreditRedis();
  return {
    redis,
    subject: createRedisCreditBalanceStore({
      commands: redis,
      ...(prefix === undefined ? {} : { keyPrefix: prefix }),
    }),
  };
}

describe('credit key layout', () => {
  it('namespaces balance and in-flight counters separately per account', async () => {
    const { redis, subject } = store();

    await subject.initialise('account-1', 100);
    await subject.tryAcquireJobSlot('account-1', 2);

    expect(redis.keys()).toEqual([
      balanceKey(CREDIT_KEY_PREFIX, 'account-1'),
      inFlightKey(CREDIT_KEY_PREFIX, 'account-1'),
    ]);
  });

  it('honours a custom prefix so environments can share one Redis', async () => {
    const { redis, subject } = store('staging:credit');

    await subject.initialise('account-1', 5);

    expect(redis.keys()).toEqual(['staging:credit:balance:account-1']);
  });
});

describe('initialise (Requirement 2.1)', () => {
  it('sets the opening balance once', async () => {
    const { subject } = store();

    expect(await subject.initialise('account-1', 100)).toEqual({ applied: true, balance: 100 });
    expect(await subject.initialise('account-1', 5_000)).toEqual({ applied: false, balance: 100 });
  });
});

describe('tryDebit (Requirements 2.2, 2.3)', () => {
  it('applies a debit that fits and reports the new balance', async () => {
    const { subject } = store();
    await subject.initialise('account-1', 100);

    expect(await subject.tryDebit('account-1', 40)).toEqual({ applied: true, balance: 60 });
  });

  it('permits a debit that lands exactly on zero', async () => {
    const { subject } = store();
    await subject.initialise('account-1', 40);

    expect(await subject.tryDebit('account-1', 40)).toEqual({ applied: true, balance: 0 });
  });

  it('refuses to overdraw and leaves the balance where it was', async () => {
    const { subject } = store();
    await subject.initialise('account-1', 39);

    expect(await subject.tryDebit('account-1', 40)).toEqual({ applied: false, balance: 39 });
    expect(await subject.balanceOf('account-1')).toBe(39);
  });

  it('treats an unknown account as a zero balance rather than an error', async () => {
    const { subject } = store();

    expect(await subject.balanceOf('ghost')).toBe(0);
    expect(await subject.tryDebit('ghost', 1)).toEqual({ applied: false, balance: 0 });
  });

  it('rejects a non-positive or fractional amount', async () => {
    const { subject } = store();

    await expect(subject.tryDebit('account-1', 0)).rejects.toMatchObject({
      code: 'charge_amount_invalid',
    });
    await expect(subject.tryDebit('account-1', 1.5)).rejects.toMatchObject({
      code: 'charge_amount_invalid',
    });
  });

  it('decides inside one script call, never a read followed by a write', async () => {
    const { redis, subject } = store();
    await subject.initialise('account-1', 100);

    await subject.tryDebit('account-1', 10);

    // One EVAL, and no GET of the balance: the guard cannot be raced.
    expect(redis.evalCount(TRY_DEBIT_SCRIPT)).toBe(1);
  });
});

describe('job slots (Requirements 2.5, 2.6)', () => {
  it('admits jobs up to the cap and refuses the next one', async () => {
    const { subject } = store();

    expect(await subject.tryAcquireJobSlot('account-1', 2)).toEqual({
      acquired: true,
      jobsInFlight: 1,
    });
    expect(await subject.tryAcquireJobSlot('account-1', 2)).toEqual({
      acquired: true,
      jobsInFlight: 2,
    });
    expect(await subject.tryAcquireJobSlot('account-1', 2)).toEqual({
      acquired: false,
      jobsInFlight: 2,
    });
  });

  it('frees a slot on release and never goes below zero', async () => {
    const { subject } = store();
    await subject.tryAcquireJobSlot('account-1', 1);

    expect(await subject.releaseJobSlot('account-1')).toBe(0);
    expect(await subject.releaseJobSlot('account-1')).toBe(0);
    expect(await subject.jobsInFlight('account-1')).toBe(0);
  });

  it('counts in-flight jobs per account', async () => {
    const { subject } = store();

    await subject.tryAcquireJobSlot('account-1', 3);
    await subject.tryAcquireJobSlot('account-1', 3);
    await subject.tryAcquireJobSlot('account-2', 3);

    expect(await subject.jobsInFlight('account-1')).toBe(2);
    expect(await subject.jobsInFlight('account-2')).toBe(1);
  });

  it('takes the slot decision inside one script call', async () => {
    const { redis, subject } = store();

    await subject.tryAcquireJobSlot('account-1', 1);

    expect(redis.evalCount(TRY_ACQUIRE_SLOT_SCRIPT)).toBe(1);
  });
});

describe('credit (Requirements 2.4, 2.8)', () => {
  it('increases the balance and returns the new value', async () => {
    const { subject } = store();
    await subject.initialise('account-1', 10);

    expect(await subject.credit('account-1', 90)).toBe(100);
  });

  it('rejects a non-positive credit', async () => {
    const { subject } = store();

    await expect(subject.credit('account-1', -5)).rejects.toMatchObject({
      code: 'charge_amount_invalid',
    });
  });
});

describe('atomic script inventory', () => {
  it('has a modelled counterpart for every script the store can run', async () => {
    const { subject, redis } = store();

    // If a script is added without a model, the fake throws rather than guessing.
    await subject.initialise('a', 1);
    await subject.tryDebit('a', 1);
    await subject.tryAcquireJobSlot('a', 1);
    await subject.releaseJobSlot('a');

    for (const script of Object.values(ATOMIC_SCRIPTS)) {
      expect(redis.evalCount(script)).toBeGreaterThan(0);
    }
  });

  it('guards every decision inside the script, not around it', () => {
    // The three guarded scripts return {applied, value} and write only on the
    // permitted branch, so the guard and the mutation are one step.
    for (const name of ['initialiseBalance', 'tryDebit', 'tryAcquireSlot'] as const) {
      const script = ATOMIC_SCRIPTS[name];
      expect(script, name).toMatch(/return \{0,/);
      expect(script, name).toMatch(/return \{1, redis\.call|redis\.call\('SET'/);
    }

    // `releaseSlot` takes no decision a caller could race on; it only settles.
    expect(ATOMIC_SCRIPTS.releaseSlot).toMatch(/redis\.call\('DECR'/);
  });

  it('rejects a reply that is not the guarded pair', () => {
    expect(() => decodeGuardedReply('nonsense')).toThrow(/guarded credit script/);
    expect(decodeGuardedReply(['1', '42'])).toEqual({ applied: true, value: 42 });
  });
});
