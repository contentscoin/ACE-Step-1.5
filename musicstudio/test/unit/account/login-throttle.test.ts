import { describe, expect, it } from 'vitest';

import { createRedisLoginAttemptStore } from '../../../services/account/adapters/redis-login-attempt-store';
import {
  createLoginThrottle,
  LOGIN_LOCK_DURATION_SECONDS,
  MAX_CONSECUTIVE_LOGIN_FAILURES,
} from '../../../services/account/login-throttle';
import { createFakeRedis } from '../../support/fake-redis';
import { createMutableClock } from '../../support/mutable-clock';

function createThrottle() {
  const clock = createMutableClock();
  const redis = createFakeRedis(clock);
  const store = createRedisLoginAttemptStore({ commands: redis });
  return { clock, redis, throttle: createLoginThrottle({ store, clock }) };
}

/** Requirements 1.4 and 1.5. */
describe('login throttle', () => {
  it('counts consecutive failures', async () => {
    const { throttle } = createThrottle();

    expect((await throttle.recordFailure('user@example.com')).failures).toBe(1);
    expect((await throttle.recordFailure('user@example.com')).failures).toBe(2);
  });

  it('allows login while the failure count is below the threshold', async () => {
    const { throttle } = createThrottle();

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES - 1; attempt += 1) {
      await throttle.recordFailure('user@example.com');
    }

    await expect(throttle.assertNotLocked('user@example.com')).resolves.toBeUndefined();
  });

  it('refuses login for 15 minutes once the threshold is reached', async () => {
    const { clock, throttle } = createThrottle();

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES; attempt += 1) {
      await throttle.recordFailure('user@example.com');
    }

    await expect(throttle.assertNotLocked('user@example.com')).rejects.toMatchObject({
      statusCode: 429,
      code: 'login_temporarily_locked',
      details: { retryAfterSeconds: LOGIN_LOCK_DURATION_SECONDS },
    });

    clock.advanceSeconds(LOGIN_LOCK_DURATION_SECONDS - 1);
    await expect(throttle.assertNotLocked('user@example.com')).rejects.toMatchObject({
      details: { retryAfterSeconds: 1 },
    });

    clock.advanceSeconds(1);
    await expect(throttle.assertNotLocked('user@example.com')).resolves.toBeUndefined();
  });

  it('starts a fresh streak after an elapsed lock', async () => {
    const { clock, throttle } = createThrottle();
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES; attempt += 1) {
      await throttle.recordFailure('user@example.com');
    }

    clock.advanceSeconds(LOGIN_LOCK_DURATION_SECONDS);
    const next = await throttle.recordFailure('user@example.com');

    expect(next.failures).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });

  it('clears the counter on reset', async () => {
    const { throttle } = createThrottle();
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES; attempt += 1) {
      await throttle.recordFailure('user@example.com');
    }

    await throttle.reset('user@example.com');

    await expect(throttle.assertNotLocked('user@example.com')).resolves.toBeUndefined();
    expect((await throttle.recordFailure('user@example.com')).failures).toBe(1);
  });

  it('tracks each address independently', async () => {
    const { throttle } = createThrottle();
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_LOGIN_FAILURES; attempt += 1) {
      await throttle.recordFailure('locked@example.com');
    }

    await expect(throttle.assertNotLocked('locked@example.com')).rejects.toMatchObject({
      code: 'login_temporarily_locked',
    });
    await expect(throttle.assertNotLocked('other@example.com')).resolves.toBeUndefined();
  });
});
