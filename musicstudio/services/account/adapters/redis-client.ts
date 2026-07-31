import Redis from 'ioredis';

import type { RedisCommands } from './redis-commands';

/**
 * Concrete Redis connection.
 *
 * Intentionally the only module that names `ioredis`: everything else in the
 * account layer depends on the `RedisCommands` surface, which keeps the stores
 * unit-testable and the client swappable. Not covered by tests — it has no
 * logic beyond connecting and forwarding three commands.
 */
export interface RedisConnection extends RedisCommands {
  close(): Promise<void>;
}

export function createRedisConnection(url: string): RedisConnection {
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });

  return {
    get: (key) => client.get(key),
    set: (key, value, mode, ttlSeconds) => client.set(key, value, mode, ttlSeconds),
    del: (key) => client.del(key),
    close: async () => {
      await client.quit();
    },
  };
}
