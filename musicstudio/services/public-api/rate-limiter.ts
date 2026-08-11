/**
 * Requirements 17.7, 17.8 — the per-key limit, applied.
 *
 * The decision is `domain/public-api/rate-limit.ts`'s; what is here is the one thing that
 * cannot be pure — counting, atomically, across whatever processes are serving the API.
 *
 * ### The refusal does not count
 *
 * A request that is turned away leaves the counter where it was, so the stored count never
 * exceeds the limit.
 *
 * It is worth being precise about what this does *not* buy, because the plausible-sounding
 * version is false: with a fixed window it cannot lock a client out for longer, since the
 * window rolls over on the clock rather than on the count. What it buys is that the stored
 * number stays bounded — a client hammering a refused endpoint for an hour leaves a counter at
 * the limit rather than at a million — and that `remaining` keeps meaning "requests left in
 * this window" instead of drifting into a negative that has to be clamped at every read.
 *
 * If the window ever becomes a sliding one, this stops being a tidiness argument and starts
 * being the one above; that is the change that would make it load-bearing.
 */

import {
  retryAfterSeconds,
  windowStartFor,
  RATE_LIMIT_WINDOW_MS,
  type RateLimitDecision,
} from '../../domain/public-api/rate-limit';
import type { Clock } from '../clock';
import { systemClock } from '../clock';
import { publicApiRateLimited } from './errors';
import type { RateLimitStore } from './ports';

export interface RateLimiterOptions {
  readonly store: RateLimitStore;
  readonly clock?: Clock;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { store } = options;
  const clock = options.clock ?? systemClock;

  return {
    /**
     * Count a request against the key's window.
     *
     * Throws Requirement 17.8's 429 rather than returning a flag, because every caller of this
     * is a route that would immediately turn a `false` into the same throw — and one of them
     * would eventually forget.
     */
    async consume(keyId: string, limit: number): Promise<RateLimitDecision> {
      const nowMs = clock.now().getTime();
      const window = await store.consume(keyId, nowMs, limit);
      const retryAtMs = windowStartFor(nowMs) + RATE_LIMIT_WINDOW_MS;

      if (window === null) {
        throw publicApiRateLimited({
          limit,
          retryAtMs,
          retryAfterSeconds: retryAfterSeconds(retryAtMs, nowMs),
        });
      }

      return {
        allowed: true,
        remaining: Math.max(0, limit - window.count),
        limit,
        retryAtMs,
      };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * The store design §11.3 puts on Redis, as a single-process map.
 *
 * Exported from the service layer rather than kept in the tests because it is also the right
 * implementation for a single-instance deployment, and because a reader comparing it with the
 * Redis one can see that `consume` is one operation in both.
 */
export function inMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { windowStartMs: number; count: number }>();

  return {
    async consume(keyId, nowMs, limit) {
      const windowStartMs = windowStartFor(nowMs);
      const existing = windows.get(keyId);
      const count =
        existing !== undefined && existing.windowStartMs === windowStartMs ? existing.count : 0;

      if (count + 1 > limit) return null;

      const next = { windowStartMs, count: count + 1 };
      windows.set(keyId, next);
      return next;
    },

    async peek(keyId, nowMs) {
      const existing = windows.get(keyId);
      if (existing === undefined || existing.windowStartMs !== windowStartFor(nowMs)) return null;
      return existing;
    },
  };
}
