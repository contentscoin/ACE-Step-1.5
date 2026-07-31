import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createRedisLoginAttemptStore } from '../../services/account/adapters/redis-login-attempt-store';
import {
  createLoginThrottle,
  LOGIN_LOCK_DURATION_SECONDS,
  MAX_CONSECUTIVE_LOGIN_FAILURES,
} from '../../services/account/login-throttle';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createJwtTokenService,
} from '../../services/account/token-service';
import { createFakeRedis } from '../support/fake-redis';
import { createMutableClock } from '../support/mutable-clock';

/**
 * Local invariants for task 1.2. These are not the numbered correctness
 * properties of design §10 (which cover parsers, mixdown and licensing); they
 * pin the two Requirement 1 rules whose behaviour is a function of unbounded
 * inputs — identifier content and elapsed time — and so are worth checking
 * across many cases rather than a handful of examples.
 */
const SECRET = 'property-test-secret-of-at-least-32-chars';

const NUM_RUNS = 100;

const identifier = fc.string({ minLength: 1, maxLength: 64 });

describe('access token validity is a function of elapsed time only', () => {
  /**
   * For any account/session identifier, an access token verifies to those same
   * identifiers at every instant before its expiry, and reports
   * `token_expired` at or after it.
   *
   * **Validates: Requirements 1.3, 1.8**
   */
  it('round-trips before expiry and reports expiry afterwards', async () => {
    await fc.assert(
      fc.asyncProperty(
        identifier,
        identifier,
        fc.integer({ min: 0, max: ACCESS_TOKEN_TTL_SECONDS - 1 }),
        fc.integer({ min: 0, max: 365 * 24 * 60 * 60 }),
        async (accountId, sessionId, elapsedBeforeExpiry, elapsedAfterExpiry) => {
          const clock = createMutableClock();
          const tokens = createJwtTokenService({ secret: SECRET, clock });
          const pair = await tokens.issuePair({ accountId, sessionId });

          clock.advanceSeconds(elapsedBeforeExpiry);
          const claims = await tokens.verify(pair.accessToken, 'access');
          expect(claims.accountId).toBe(accountId);
          expect(claims.sessionId).toBe(sessionId);

          clock.advanceSeconds(ACCESS_TOKEN_TTL_SECONDS - elapsedBeforeExpiry + elapsedAfterExpiry);
          await expect(tokens.verify(pair.accessToken, 'access')).rejects.toMatchObject({
            code: 'token_expired',
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('login lockout threshold', () => {
  /**
   * For any number of consecutive failures, login is refused exactly when the
   * count has reached the threshold, and the refusal lasts exactly the lock
   * duration.
   *
   * **Validates: Requirements 1.4, 1.5**
   */
  it('refuses login iff the failure count reached the threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 * MAX_CONSECUTIVE_LOGIN_FAILURES }),
        identifier,
        async (failures, key) => {
          const clock = createMutableClock();
          const throttle = createLoginThrottle({
            store: createRedisLoginAttemptStore({ commands: createFakeRedis(clock) }),
            clock,
          });

          for (let attempt = 0; attempt < failures; attempt += 1) {
            await throttle.recordFailure(key);
          }

          const shouldBeLocked = failures >= MAX_CONSECUTIVE_LOGIN_FAILURES;
          const locked = await isLocked(throttle, key);
          expect(locked).toBe(shouldBeLocked);

          // Whatever the count, the refusal never outlives the lock window.
          clock.advanceSeconds(LOGIN_LOCK_DURATION_SECONDS);
          expect(await isLocked(throttle, key)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

async function isLocked(
  throttle: { assertNotLocked(key: string): Promise<void> },
  key: string,
): Promise<boolean> {
  try {
    await throttle.assertNotLocked(key);
    return false;
  } catch {
    return true;
  }
}
