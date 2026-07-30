import bcrypt from 'bcrypt';

import { passwordTooLong } from './errors';

/**
 * Requirement 1.6: passwords are stored only as a one-way hash with a work
 * factor of at least 12. The floor is enforced in code, not by convention, so
 * a misconfigured cost fails at construction time rather than silently
 * weakening every stored credential.
 */
export const MINIMUM_PASSWORD_HASH_COST = 12;

/** bcrypt ignores input past 72 bytes; longer passwords are rejected instead. */
export const MAX_PASSWORD_BYTES = 72;

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, hash: string): Promise<boolean>;
  readonly cost: number;
}

/** Extracts the work factor from a modular-crypt bcrypt hash, or `null`. */
export function parsePasswordHashCost(hash: string): number | null {
  const match = /^\$2[abxy]?\$(\d{2})\$/.exec(hash);
  if (match?.[1] === undefined) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

export function createBcryptPasswordHasher(cost: number = MINIMUM_PASSWORD_HASH_COST): PasswordHasher {
  if (!Number.isInteger(cost) || cost < MINIMUM_PASSWORD_HASH_COST) {
    throw new RangeError(
      `Password hash cost must be an integer >= ${MINIMUM_PASSWORD_HASH_COST} (Requirement 1.6); received ${cost}.`,
    );
  }

  return {
    cost,

    async hash(plaintext: string): Promise<string> {
      assertHashableLength(plaintext);
      return bcrypt.hash(plaintext, cost);
    },

    async verify(plaintext: string, hash: string): Promise<boolean> {
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
        return false;
      }
      return bcrypt.compare(plaintext, hash);
    },
  };
}

function assertHashableLength(plaintext: string): void {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    throw passwordTooLong(MAX_PASSWORD_BYTES);
  }
}
