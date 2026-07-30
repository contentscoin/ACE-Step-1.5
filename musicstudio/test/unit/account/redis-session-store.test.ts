import { describe, expect, it } from 'vitest';

import { createRedisSessionStore } from '../../../services/account/adapters/redis-session-store';
import { addSeconds } from '../../../services/account/clock';
import { createFakeRedis } from '../../support/fake-redis';
import { createMutableClock } from '../../support/mutable-clock';

function createStore() {
  const clock = createMutableClock();
  const redis = createFakeRedis(clock);
  return { clock, redis, store: createRedisSessionStore({ commands: redis, clock }) };
}

function sessionOf(clock: { now(): Date }, ttlSeconds: number) {
  return {
    sessionId: 'session-1',
    accountId: 'account-1',
    issuedAt: clock.now(),
    expiresAt: addSeconds(clock.now(), ttlSeconds),
  };
}

/** Design §2.4 — Redis session cache. */
describe('Redis session store', () => {
  it('round-trips a session record', async () => {
    const { clock, store } = createStore();
    const record = sessionOf(clock, 3600);

    await store.save(record);

    expect(await store.find('session-1')).toEqual(record);
  });

  it('namespaces keys and sets a TTL matching the session lifetime', async () => {
    const { clock, redis, store } = createStore();

    await store.save(sessionOf(clock, 3600));

    expect(redis.liveKeys()).toEqual(['musicstudio:session:session-1']);
    expect(redis.ttlOf('musicstudio:session:session-1')).toBe(3600);
  });

  it('reports a miss for an unknown session', async () => {
    const { store } = createStore();

    expect(await store.find('never-created')).toBeNull();
  });

  it('lets the entry expire with the session', async () => {
    const { clock, store } = createStore();
    await store.save(sessionOf(clock, 60));

    clock.advanceSeconds(59);
    expect(await store.find('session-1')).not.toBeNull();

    clock.advanceSeconds(2);
    expect(await store.find('session-1')).toBeNull();
  });

  it('removes the entry on delete', async () => {
    const { clock, redis, store } = createStore();
    await store.save(sessionOf(clock, 3600));

    await store.delete('session-1');

    expect(await store.find('session-1')).toBeNull();
    expect(redis.liveKeys()).toEqual([]);
  });

  it('treats a corrupt cache entry as a miss rather than failing the request', async () => {
    const { redis, store } = createStore();
    await redis.set('musicstudio:session:session-1', 'not json', 'EX', 60);

    expect(await store.find('session-1')).toBeNull();
  });

  it('rounds a sub-second lifetime up to the Redis minimum TTL', async () => {
    const { clock, redis, store } = createStore();

    await store.save({
      sessionId: 'session-2',
      accountId: 'account-1',
      issuedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 100),
    });

    expect(redis.ttlOf('musicstudio:session:session-2')).toBe(1);
  });
});
