import type { LoginAttemptState, LoginAttemptStore } from '../login-throttle';

import { toRedisTtlSeconds, type RedisCommands } from './redis-commands';

export const DEFAULT_LOGIN_ATTEMPT_KEY_PREFIX = 'musicstudio:login-attempts:';

export interface RedisLoginAttemptStoreOptions {
  readonly commands: RedisCommands;
  readonly keyPrefix?: string;
}

/**
 * Redis-backed failure counter for Requirements 1.4 and 1.5.
 *
 * Redis (not process memory) holds the counter so the lockout applies across
 * every gateway instance; the key's TTL also gives the counter its natural
 * decay once an account stops failing.
 */
export function createRedisLoginAttemptStore(
  options: RedisLoginAttemptStoreOptions,
): LoginAttemptStore {
  const prefix = options.keyPrefix ?? DEFAULT_LOGIN_ATTEMPT_KEY_PREFIX;
  const { commands } = options;

  const keyOf = (key: string): string => `${prefix}${key}`;

  return {
    async read(key): Promise<LoginAttemptState | null> {
      const raw = await commands.get(keyOf(key));
      return raw === null ? null : deserialize(raw);
    },

    async write(key, state, ttlSeconds): Promise<void> {
      await commands.set(
        keyOf(key),
        JSON.stringify({
          failures: state.failures,
          lockedUntil: state.lockedUntil === null ? null : state.lockedUntil.toISOString(),
        }),
        'EX',
        toRedisTtlSeconds(ttlSeconds),
      );
    },

    async clear(key): Promise<void> {
      await commands.del(keyOf(key));
    },
  };
}

function deserialize(raw: string): LoginAttemptState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as { failures?: unknown; lockedUntil?: unknown };
  if (typeof candidate.failures !== 'number') {
    return null;
  }

  return {
    failures: candidate.failures,
    lockedUntil:
      typeof candidate.lockedUntil === 'string' ? new Date(candidate.lockedUntil) : null,
  };
}
