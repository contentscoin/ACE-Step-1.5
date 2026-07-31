import {
  INITIALISE_BALANCE_SCRIPT,
  RELEASE_SLOT_SCRIPT,
  TRY_ACQUIRE_SLOT_SCRIPT,
  TRY_DEBIT_SCRIPT,
} from '../../services/credit/adapters/atomic-scripts';
import type { CreditRedisCommands } from '../../services/credit/adapters/redis-credit-commands';

/**
 * In-process Redis stand-in for the credit store.
 *
 * `eval` is dispatched on the script *source*, and each branch is a JavaScript
 * model of that script's semantics. That is what lets the tests exercise the real
 * `createRedisCreditBalanceStore` — key layout, argument order, reply decoding
 * included — with no Redis server, in the same spirit as `fake-redis.ts` for the
 * session store. An unrecognised script throws rather than being guessed at, so
 * adding a script without modelling it fails loudly.
 *
 * ## Modelling the atomicity guarantee
 *
 * Redis serves one command at a time and runs a script to completion, so the
 * *round trip* interleaves but the script body never does. This double reproduces
 * exactly that: `eval` yields to the microtask queue first (the round trip), then
 * runs its critical section with no `await` inside it. A store that read a value,
 * awaited, and wrote it back would therefore lose the race here just as it would
 * against a real Redis — which is what makes the concurrency property test in
 * `test/property/credit-atomicity.test.ts` meaningful rather than vacuous.
 */
export interface FakeCreditRedis extends CreditRedisCommands {
  /** Every key currently set, sorted. */
  keys(): string[];
  valueOf(key: string): number;
  /** How many times `eval` ran, per script. */
  evalCount(script: string): number;
}

export function createFakeCreditRedis(): FakeCreditRedis {
  const values = new Map<string, number>();
  const evalCounts = new Map<string, number>();

  const read = (key: string): number => values.get(key) ?? 0;

  const yieldToEventLoop = (): Promise<void> => Promise.resolve();

  return {
    async eval(script, numKeys, ...args) {
      evalCounts.set(script, (evalCounts.get(script) ?? 0) + 1);
      const key = String(args[0] ?? '');
      const argv = args.slice(numKeys).map((value) => Number(value));

      // The round trip, not the script body, is where interleaving happens.
      await yieldToEventLoop();

      switch (script) {
        case INITIALISE_BALANCE_SCRIPT: {
          if (values.has(key)) return [0, read(key)];
          values.set(key, argv[0] ?? 0);
          return [1, read(key)];
        }
        case TRY_DEBIT_SCRIPT: {
          const amount = argv[0] ?? 0;
          const balance = read(key);
          if (balance < amount) return [0, balance];
          values.set(key, balance - amount);
          return [1, read(key)];
        }
        case TRY_ACQUIRE_SLOT_SCRIPT: {
          const limit = argv[0] ?? 0;
          const inFlight = read(key);
          if (inFlight >= limit) return [0, inFlight];
          values.set(key, inFlight + 1);
          return [1, read(key)];
        }
        case RELEASE_SLOT_SCRIPT: {
          const inFlight = read(key);
          if (inFlight <= 0) {
            values.set(key, 0);
            return 0;
          }
          values.set(key, inFlight - 1);
          return read(key);
        }
        default:
          throw new Error(`fake credit Redis has no model for this script:\n${script}`);
      }
    },

    async get(key) {
      await yieldToEventLoop();
      return values.has(key) ? String(read(key)) : null;
    },

    async incrby(key, increment) {
      await yieldToEventLoop();
      values.set(key, read(key) + increment);
      return read(key);
    },

    keys() {
      return [...values.keys()].sort();
    },

    valueOf(key) {
      return read(key);
    },

    evalCount(script) {
      return evalCounts.get(script) ?? 0;
    },
  };
}
