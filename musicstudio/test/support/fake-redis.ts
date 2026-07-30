import type { Clock } from '../../services/account/clock';
import type { RedisCommands } from '../../services/account/adapters/redis-commands';

/**
 * In-process Redis stand-in implementing the `GET`/`SET key value EX ttl`/`DEL`
 * semantics the account layer uses, including TTL expiry.
 *
 * Expiry is evaluated against the injected clock, so tests exercise the real
 * `createRedisSessionStore` / `createRedisLoginAttemptStore` adapters — key
 * layout, serialisation and TTL arithmetic included — without a Redis server.
 */
export interface FakeRedis extends RedisCommands {
  /** Keys that have not yet expired, sorted. */
  liveKeys(): string[];
  ttlOf(key: string): number | null;
}

interface Entry {
  value: string;
  expiresAtMs: number;
}

export function createFakeRedis(clock: Clock): FakeRedis {
  const entries = new Map<string, Entry>();

  const readLive = (key: string): Entry | null => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= clock.now().getTime()) {
      entries.delete(key);
      return null;
    }
    return entry;
  };

  return {
    async get(key) {
      return readLive(key)?.value ?? null;
    },

    async set(key, value, _mode, ttlSeconds) {
      entries.set(key, {
        value,
        expiresAtMs: clock.now().getTime() + ttlSeconds * 1000,
      });
      return 'OK';
    },

    async del(key) {
      return entries.delete(key) ? 1 : 0;
    },

    liveKeys() {
      return [...entries.keys()].filter((key) => readLive(key) !== null).sort();
    },

    ttlOf(key) {
      const entry = readLive(key);
      if (entry === null) {
        return null;
      }
      return Math.ceil((entry.expiresAtMs - clock.now().getTime()) / 1000);
    },
  };
}
