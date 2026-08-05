/**
 * Per-key request limiting — Requirements 17.7, 17.8.
 *
 * > THE Public_API SHALL API 키별 분당 요청 수 상한을 적용한다
 * > IF … 초과하면, THEN … HTTP 429 상태 코드와 **재시도 가능 시각**을 반환한다
 *
 * ### A fixed window, and what that costs
 *
 * The window is the wall-clock minute a request falls in: floor the timestamp to 60 000 ms and
 * count. That admits the classic burst — 60 requests at 11:59:59.9 and 60 more at 12:00:00.1 is
 * 120 requests in 200 ms, and both minutes are within their limit. A sliding window would not,
 * and the reason not to reach for one is that it needs the timestamps of every request in the
 * trailing minute per key, where this needs a counter and an integer.
 *
 * The clause bounds 분당 요청 수 and this bounds requests per minute exactly. The burst is a
 * property of *which* minute, not a breach of the count, and the alternative buys a smoother
 * curve for a per-key data structure that grows with traffic. Stated here rather than
 * discovered: if a later requirement bounds the rate over a rolling interval, this is the
 * module that changes.
 *
 * ### The retry time is the window's end, not a duration
 *
 * 17.8 asks for 재시도 가능 시각 — a time. `retryAtMs` is that time, and the HTTP header derives
 * a `Retry-After` in seconds from it rather than the other way round: a duration computed at the
 * limiter and carried through a queue arrives already stale, while an instant does not.
 *
 * Seconds are rounded **up**. Rounding down would name a moment inside the window that is still
 * over the limit, so a client obeying the header exactly gets a second 429 — and a client that
 * retries on a 429 in a loop is how a rate limit becomes a load generator.
 */

/** Requirement 17.7's default. A per-key override is a product decision, not a clause. */
export const DEFAULT_REQUESTS_PER_MINUTE = 60;

export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitWindow {
  /** Start of the minute this window covers. */
  readonly windowStartMs: number;
  readonly count: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How many more requests this window admits, after this one. */
  readonly remaining: number;
  readonly limit: number;
  /** Requirement 17.8 — when the caller may try again. Always the window's end. */
  readonly retryAtMs: number;
}

export function windowStartFor(nowMs: number): number {
  return Math.floor(nowMs / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
}

/**
 * Decide, given the window a store holds for this key.
 *
 * `window` being from an *older* minute is the ordinary case, not an error: it means nothing has
 * been counted yet this minute, so the count restarts at one.
 */
export function decideRateLimit(
  window: RateLimitWindow | null,
  nowMs: number,
  limit: number = DEFAULT_REQUESTS_PER_MINUTE,
): RateLimitDecision {
  const windowStartMs = windowStartFor(nowMs);
  const retryAtMs = windowStartMs + RATE_LIMIT_WINDOW_MS;
  const current = window !== null && window.windowStartMs === windowStartMs ? window.count : 0;

  // A limit of zero admits nothing, and `next > limit` says so without a special case.
  const next = current + 1;
  if (next > limit) {
    return { allowed: false, remaining: 0, limit, retryAtMs };
  }
  return { allowed: true, remaining: limit - next, limit, retryAtMs };
}

/** The window to store after an admitted request. */
export function advanceWindow(window: RateLimitWindow | null, nowMs: number): RateLimitWindow {
  const windowStartMs = windowStartFor(nowMs);
  const current = window !== null && window.windowStartMs === windowStartMs ? window.count : 0;
  return { windowStartMs, count: current + 1 };
}

/**
 * `Retry-After` in seconds, rounded up. See the module header for why up.
 *
 * At least 1: a `Retry-After: 0` invites an immediate retry that is still inside the window.
 */
export function retryAfterSeconds(retryAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000));
}
