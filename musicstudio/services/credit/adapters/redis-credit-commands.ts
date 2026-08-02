/**
 * The Redis command surface the credit store needs.
 *
 * Declared rather than depending on a concrete client, for the same reason
 * `services/account/adapters/redis-commands.ts` does: the store adapter stays
 * unit-testable against a double that implements these semantics, and `ioredis`
 * stays confined to the deployment edge. The signatures are the `ioredis` ones,
 * so a real client satisfies this type as it is.
 */
export interface CreditRedisCommands {
  /** `EVAL script numkeys key [key ...] arg [arg ...]`. */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  incrby(key: string, increment: number): Promise<number>;
}

/** Default key namespace; overridable so several environments can share Redis. */
export const CREDIT_KEY_PREFIX = 'musicstudio:credit';

export function balanceKey(prefix: string, accountId: string): string {
  return `${prefix}:balance:${accountId}`;
}

export function inFlightKey(prefix: string, accountId: string): string {
  return `${prefix}:jobs-in-flight:${accountId}`;
}

/**
 * Reads the `{applied, value}` pair every guarded script returns.
 *
 * Redis renders a Lua table of integers as an array of numbers, but a client may
 * hand them back as strings, so both are accepted rather than trusted.
 */
export function decodeGuardedReply(reply: unknown): { applied: boolean; value: number } {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error(`unexpected Redis reply for a guarded credit script: ${JSON.stringify(reply)}`);
  }
  return { applied: Number(reply[0]) === 1, value: Number(reply[1]) };
}

export function decodeInteger(reply: unknown): number {
  const value = Number(reply);
  if (!Number.isFinite(value)) {
    throw new Error(`unexpected Redis reply, expected an integer: ${JSON.stringify(reply)}`);
  }
  return value;
}
