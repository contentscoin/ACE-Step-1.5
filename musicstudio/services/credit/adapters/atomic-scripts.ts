/**
 * Lua scripts behind the atomic operations of `CreditBalanceStore`.
 *
 * ## Why Lua rather than WATCH/MULTI
 *
 * Both approaches are correct. `EVAL` was chosen because Redis runs a script to
 * completion before serving any other client, which makes the guard and the
 * mutation one indivisible step with no retry loop and no failure mode to test:
 * a `WATCH`/`MULTI` deduction has to re-read and re-attempt whenever the key
 * changed, and every retry is a code path that can be got wrong under load. The
 * scripts below therefore *cannot* lose the Requirement 2.3 race — there is no
 * window between reading the balance and writing it.
 *
 * Each script returns `{applied, value}` where `applied` is `1` or `0`. Reporting
 * the resulting counter from inside the script matters as much as the guard: the
 * in-flight count Requirement 2.6 returns is read at the instant the decision was
 * taken, not by a second round trip that could already be stale.
 *
 * Values are plain integers (credits and job counts), so `tonumber` is exact and
 * no rounding can enter the balance.
 */

/** Opening balance, once (Requirement 2.1). `SETNX` semantics, made observable. */
export const INITIALISE_BALANCE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {0, tonumber(existing)}
end
redis.call('SET', KEYS[1], ARGV[1])
return {1, tonumber(ARGV[1])}
`;

/** Requirements 2.2, 2.3: never overdraw, never block a debit that fits. */
export const TRY_DEBIT_SCRIPT = `
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if balance < amount then
  return {0, balance}
end
return {1, redis.call('DECRBY', KEYS[1], amount)}
`;

/** Requirements 2.5, 2.6: admit a job only while below the plan's cap. */
export const TRY_ACQUIRE_SLOT_SCRIPT = `
local inFlight = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if inFlight >= limit then
  return {0, inFlight}
end
return {1, redis.call('INCR', KEYS[1])}
`;

/** Settling a job. Floors at zero so a duplicate callback cannot go negative. */
export const RELEASE_SLOT_SCRIPT = `
local inFlight = tonumber(redis.call('GET', KEYS[1]) or '0')
if inFlight <= 0 then
  redis.call('SET', KEYS[1], '0')
  return 0
end
return redis.call('DECR', KEYS[1])
`;

export const ATOMIC_SCRIPTS = {
  initialiseBalance: INITIALISE_BALANCE_SCRIPT,
  tryDebit: TRY_DEBIT_SCRIPT,
  tryAcquireSlot: TRY_ACQUIRE_SLOT_SCRIPT,
  releaseSlot: RELEASE_SLOT_SCRIPT,
} as const;

export type AtomicScriptName = keyof typeof ATOMIC_SCRIPTS;
