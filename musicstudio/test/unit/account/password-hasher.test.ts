import { describe, expect, it } from 'vitest';

import {
  createBcryptPasswordHasher,
  MAX_PASSWORD_BYTES,
  MINIMUM_PASSWORD_HASH_COST,
  parsePasswordHashCost,
} from '../../../services/account/password-hasher';

/** Requirement 1.6: one-way hash with a work factor of at least 12. */
describe('bcrypt password hasher', () => {
  it('refuses a work factor below the required minimum', () => {
    expect(() => createBcryptPasswordHasher(MINIMUM_PASSWORD_HASH_COST - 1)).toThrow(RangeError);
    expect(() => createBcryptPasswordHasher(0)).toThrow(RangeError);
  });

  it('defaults to the required minimum work factor', () => {
    expect(createBcryptPasswordHasher().cost).toBe(MINIMUM_PASSWORD_HASH_COST);
  });

  it('stores a hash that encodes the work factor and never the plaintext', async () => {
    const hasher = createBcryptPasswordHasher();
    const hash = await hasher.hash('correct horse battery');

    expect(hash).not.toContain('correct horse battery');
    expect(parsePasswordHashCost(hash)).toBe(MINIMUM_PASSWORD_HASH_COST);
  });

  it('accepts the correct password and rejects a wrong one', async () => {
    const hasher = createBcryptPasswordHasher();
    const hash = await hasher.hash('correct horse battery');

    await expect(hasher.verify('correct horse battery', hash)).resolves.toBe(true);
    await expect(hasher.verify('correct horse batterz', hash)).resolves.toBe(false);
  });

  it('salts each hash, so equal passwords do not collide', async () => {
    const hasher = createBcryptPasswordHasher();

    const first = await hasher.hash('same password');
    const second = await hasher.hash('same password');

    expect(first).not.toBe(second);
    await expect(hasher.verify('same password', second)).resolves.toBe(true);
  });

  it('rejects a password longer than bcrypt can consume instead of truncating it', async () => {
    const hasher = createBcryptPasswordHasher();
    const overlong = 'a'.repeat(MAX_PASSWORD_BYTES + 1);

    await expect(hasher.hash(overlong)).rejects.toMatchObject({ code: 'password_too_long' });
  });

  it('reads the work factor out of a hash, and null out of a non-hash', () => {
    expect(parsePasswordHashCost('$2b$14$abcdefghijklmnopqrstuv')).toBe(14);
    expect(parsePasswordHashCost('plaintext')).toBeNull();
  });
});
