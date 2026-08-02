/**
 * Redis-backed `CreditBalanceStore` (design §2.4).
 *
 * Thin by construction: every decision is one `EVAL` of a script from
 * `atomic-scripts.ts`, so this module contributes key layout, argument order and
 * reply decoding — and no logic that could disagree with the script it calls.
 * That is what makes the atomicity argument checkable in one place.
 *
 * Credits are integers, so `credit` uses `INCRBY`, which is already atomic and
 * needs no script.
 */

import { chargeAmountInvalid } from '../errors';
import type { CreditBalanceStore, DebitOutcome, JobSlotOutcome } from '../balance-store';

import {
  INITIALISE_BALANCE_SCRIPT,
  RELEASE_SLOT_SCRIPT,
  TRY_ACQUIRE_SLOT_SCRIPT,
  TRY_DEBIT_SCRIPT,
} from './atomic-scripts';
import {
  balanceKey,
  CREDIT_KEY_PREFIX,
  decodeGuardedReply,
  decodeInteger,
  inFlightKey,
  type CreditRedisCommands,
} from './redis-credit-commands';

export interface RedisCreditBalanceStoreOptions {
  readonly commands: CreditRedisCommands;
  readonly keyPrefix?: string;
}

function requirePositiveInteger(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw chargeAmountInvalid(amount);
}

export function createRedisCreditBalanceStore(
  options: RedisCreditBalanceStoreOptions,
): CreditBalanceStore {
  const prefix = options.keyPrefix ?? CREDIT_KEY_PREFIX;
  const { commands } = options;

  return {
    async initialise(accountId, credits): Promise<DebitOutcome> {
      if (!Number.isInteger(credits) || credits < 0) throw chargeAmountInvalid(credits);
      const reply = await commands.eval(
        INITIALISE_BALANCE_SCRIPT,
        1,
        balanceKey(prefix, accountId),
        credits,
      );
      const { applied, value } = decodeGuardedReply(reply);
      return { applied, balance: value };
    },

    async balanceOf(accountId) {
      const stored = await commands.get(balanceKey(prefix, accountId));
      return stored === null ? 0 : decodeInteger(stored);
    },

    async credit(accountId, amount) {
      requirePositiveInteger(amount);
      return decodeInteger(await commands.incrby(balanceKey(prefix, accountId), amount));
    },

    async tryDebit(accountId, amount): Promise<DebitOutcome> {
      requirePositiveInteger(amount);
      const reply = await commands.eval(
        TRY_DEBIT_SCRIPT,
        1,
        balanceKey(prefix, accountId),
        amount,
      );
      const { applied, value } = decodeGuardedReply(reply);
      return { applied, balance: value };
    },

    async tryAcquireJobSlot(accountId, concurrentJobLimit): Promise<JobSlotOutcome> {
      requirePositiveInteger(concurrentJobLimit);
      const reply = await commands.eval(
        TRY_ACQUIRE_SLOT_SCRIPT,
        1,
        inFlightKey(prefix, accountId),
        concurrentJobLimit,
      );
      const { applied, value } = decodeGuardedReply(reply);
      return { acquired: applied, jobsInFlight: value };
    },

    async releaseJobSlot(accountId) {
      const reply = await commands.eval(RELEASE_SLOT_SCRIPT, 1, inFlightKey(prefix, accountId));
      return decodeInteger(reply);
    },

    async jobsInFlight(accountId) {
      const stored = await commands.get(inFlightKey(prefix, accountId));
      return stored === null ? 0 : decodeInteger(stored);
    },
  };
}
