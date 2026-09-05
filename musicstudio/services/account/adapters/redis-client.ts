import Redis from 'ioredis';

import type { CreditRedisCommands } from '../../credit/adapters/redis-credit-commands';

import type { RedisCommands } from './redis-commands';

/**
 * Concrete Redis connection.
 *
 * Intentionally the only module that names `ioredis`: everything else depends on a
 * command surface — `RedisCommands` for the account stores, `CreditRedisCommands`
 * for the credit store — which keeps the stores unit-testable and the client
 * swappable. One connection satisfies both, so the composition root opens one
 * client and hands each store the slice it declared.
 *
 * `eval` and `incrby` arrived with slice S4 (roadmap §4.4). Until then this
 * forwarded three commands, and the credit store — real, Lua-scripted, and tested
 * against an in-process double — had nothing in the tree that could carry its
 * scripts to a server. Forwarding is all this does; the atomicity the credit
 * store relies on is Redis's, in the script, and is asserted in
 * `test/integration/credit-balance-store-redis.test.ts` against a real server.
 */
export interface RedisConnection extends RedisCommands, CreditRedisCommands {
  close(): Promise<void>;
}

export function createRedisConnection(url: string): RedisConnection {
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });

  return {
    get: (key) => client.get(key),
    set: (key, value, mode, ttlSeconds) => client.set(key, value, mode, ttlSeconds),
    del: (key) => client.del(key),
    // `EVAL script numkeys key [key ...] arg [arg ...]` — ioredis takes the same shape.
    eval: (script, numKeys, ...args) => client.eval(script, numKeys, ...args),
    incrby: (key, increment) => client.incrby(key, increment),
    close: async () => {
      await client.quit();
    },
  };
}
