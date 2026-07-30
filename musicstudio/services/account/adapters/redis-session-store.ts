import { systemClock, type Clock } from '../clock';
import type { SessionRecord, SessionStore } from '../session-store';

import { toRedisTtlSeconds, type RedisCommands } from './redis-commands';

export const DEFAULT_SESSION_KEY_PREFIX = 'musicstudio:session:';

export interface RedisSessionStoreOptions {
  readonly commands: RedisCommands;
  readonly clock?: Clock;
  readonly keyPrefix?: string;
}

/**
 * Redis-backed session cache (design §2.4).
 *
 * The entry's TTL is derived from the session's own expiry, so Redis evicts it
 * at the moment the refresh token dies — no sweeper job, and no session that
 * outlives its credential.
 */
export function createRedisSessionStore(options: RedisSessionStoreOptions): SessionStore {
  const clock = options.clock ?? systemClock;
  const prefix = options.keyPrefix ?? DEFAULT_SESSION_KEY_PREFIX;
  const { commands } = options;

  const keyOf = (sessionId: string): string => `${prefix}${sessionId}`;

  return {
    async save(record): Promise<void> {
      const ttlSeconds = (record.expiresAt.getTime() - clock.now().getTime()) / 1000;
      await commands.set(
        keyOf(record.sessionId),
        serialize(record),
        'EX',
        toRedisTtlSeconds(ttlSeconds),
      );
    },

    async find(sessionId): Promise<SessionRecord | null> {
      const raw = await commands.get(keyOf(sessionId));
      return raw === null ? null : deserialize(raw);
    },

    async delete(sessionId): Promise<void> {
      await commands.del(keyOf(sessionId));
    },
  };
}

interface SerializedSession {
  sessionId: string;
  accountId: string;
  issuedAt: string;
  expiresAt: string;
}

function serialize(record: SessionRecord): string {
  const payload: SerializedSession = {
    sessionId: record.sessionId,
    accountId: record.accountId,
    issuedAt: record.issuedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
  return JSON.stringify(payload);
}

function deserialize(raw: string): SessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt cache entry is treated as a cache miss: the caller then fails
    // closed with `session_not_found` instead of throwing a 500.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<SerializedSession>;
  if (
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.accountId !== 'string' ||
    typeof candidate.issuedAt !== 'string' ||
    typeof candidate.expiresAt !== 'string'
  ) {
    return null;
  }

  return {
    sessionId: candidate.sessionId,
    accountId: candidate.accountId,
    issuedAt: new Date(candidate.issuedAt),
    expiresAt: new Date(candidate.expiresAt),
  };
}
