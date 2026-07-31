/**
 * The three Redis commands the account layer needs.
 *
 * Declaring the command surface instead of depending on a concrete client keeps
 * the store adapters testable against a fake that implements the same
 * semantics, and keeps `ioredis` confined to `redis-client.ts`. The signatures
 * are the `ioredis`/`node-redis` ones, so a real client satisfies this type as
 * it is.
 */
export interface RedisCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Redis rejects a TTL below 1 second, so sub-second lifetimes round up. */
export function toRedisTtlSeconds(ttlSeconds: number): number {
  return Math.max(1, Math.ceil(ttlSeconds));
}
