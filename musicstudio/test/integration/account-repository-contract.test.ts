import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, loadMigrations, type SqlExecutor } from '../../db/runner';
import { createPgAccountRepository } from '../../services/account/adapters/pg-account-repository';
import { createInMemoryAccountRepository } from '../support/in-memory-account-repository';
import type { AccountRepository, NewAccount } from '../../services/account/account-repository';
import { AccountError } from '../../services/account/errors';

/**
 * One contract, run against both `AccountRepository` implementations (track B1).
 *
 * ### Why the two share a suite
 *
 * Every service in this tree is tested against the in-memory double, so the double *is* the
 * behaviour as far as the rest of the suite is concerned. If it and the table disagree, every
 * test still passes and the disagreement surfaces in production. That is not hypothetical here:
 * the port has always described a nullable password hash, a verification timestamp and a list of
 * social identities, and until `0019_account_identity.sql` the table could store none of the
 * three — because nothing had ever made them meet.
 *
 * So the cases below are written once and applied to both. A case that passes for the double and
 * fails for PostgreSQL is the bug this file exists to find.
 *
 * ### The PostgreSQL half skips without a server, and that is the risk it carries
 *
 * `db-schema.test.ts` skipped for the same reason and hid a migration that could not be applied at
 * all, which is why CI now runs a `database` job. These cases run there. Locally they skip, and
 * the in-memory half still runs — so a contract violated by the double alone is caught even
 * without a server.
 *
 * ### One divergence this contract deliberately does not pin
 *
 * Linking an identity that is *already* linked: the double appends a second copy, PostgreSQL
 * raises on the primary key. Neither is pinned here because the port does not say which is right
 * and `SocialLoginService` cannot reach the case — it calls `findBySocialIdentity` first and links
 * only when that returned null. Writing a case now would fix an answer nothing has asked for. It
 * is recorded rather than left silent, so the next caller that can reach it starts from a known
 * gap instead of discovering it as a bug.
 */

const connectionString = process.env['MUSICSTUDIO_DATABASE_URL'];

function newAccount(overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'Composer@Example.COM',
    passwordHash: '$2b$12$'.padEnd(60, 'a'),
    emailVerifiedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    socialIdentities: [],
    ...overrides,
  };
}

/**
 * The cases themselves, parameterised over a factory.
 *
 * A factory rather than an instance, because the PostgreSQL implementation needs the table emptied
 * between cases and the in-memory one needs a fresh map; both are "give me an empty repository".
 */
function contractFor(name: string, create: () => Promise<AccountRepository> | AccountRepository) {
  describe(`AccountRepository contract — ${name}`, () => {
    it('stores an account and reads it back with its fields intact', async () => {
      const repository = await create();
      const created = await repository.create(newAccount());

      const found = await repository.findById(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.passwordHash).toBe(newAccount().passwordHash);
      expect(found?.emailVerifiedAt).toBeNull();
      expect(found?.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('normalises the address on the way in, so casing cannot make a second account', async () => {
      const repository = await create();
      const created = await repository.create(newAccount());
      expect(created.email).toBe('composer@example.com');
    });

    it('finds by address regardless of the casing asked for (Requirement 1.2)', async () => {
      const repository = await create();
      await repository.create(newAccount());

      for (const spelling of ['composer@example.com', 'COMPOSER@EXAMPLE.COM', ' Composer@Example.com ']) {
        expect((await repository.findByEmail(spelling))?.email).toBe('composer@example.com');
      }
    });

    it('refuses a duplicate address with the code the gateway turns into 409', async () => {
      const repository = await create();
      await repository.create(newAccount());

      // The second signup differs in id and casing — the collision is the address alone.
      const duplicate = repository.create(
        newAccount({ id: '22222222-2222-4222-8222-222222222222', email: 'COMPOSER@example.com' }),
      );

      await expect(duplicate).rejects.toThrow(AccountError);
      await expect(duplicate).rejects.toMatchObject({
        code: 'email_already_registered',
        statusCode: 409,
      });
    });

    it('stores a social-only account with no password hash (Requirements 1.6, 1.7)', async () => {
      const repository = await create();
      // The case `0002` could not represent. A sentinel string in the hash column would have made
      // this pass and left an account one careless comparison away from being open to anyone.
      const created = await repository.create(
        newAccount({ passwordHash: null, socialIdentities: [{ provider: 'google', subject: 'g-1' }] }),
      );

      expect(created.passwordHash).toBeNull();
      expect((await repository.findById(created.id))?.passwordHash).toBeNull();
    });

    it('finds an account by a social identity supplied at creation', async () => {
      const repository = await create();
      const created = await repository.create(
        newAccount({ socialIdentities: [{ provider: 'apple', subject: 'a-9' }] }),
      );

      const found = await repository.findBySocialIdentity({ provider: 'apple', subject: 'a-9' });
      expect(found?.id).toBe(created.id);
    });

    it('does not match a subject belonging to another provider', async () => {
      const repository = await create();
      await repository.create(newAccount({ socialIdentities: [{ provider: 'apple', subject: 's' }] }));

      expect(await repository.findBySocialIdentity({ provider: 'google', subject: 's' })).toBeNull();
    });

    it('links an identity to an existing account and finds it afterwards', async () => {
      const repository = await create();
      const created = await repository.create(newAccount());

      await repository.linkSocialIdentity(created.id, { provider: 'google', subject: 'g-2' });

      const found = await repository.findBySocialIdentity({ provider: 'google', subject: 'g-2' });
      expect(found?.id).toBe(created.id);
      expect(found?.socialIdentities).toContainEqual({ provider: 'google', subject: 'g-2' });
    });

    it('records the verification timestamp (Requirement 1.1)', async () => {
      const repository = await create();
      const created = await repository.create(newAccount());
      const verifiedAt = new Date('2026-02-03T04:05:06.000Z');

      await repository.markEmailVerified(created.id, verifiedAt);

      expect((await repository.findById(created.id))?.emailVerifiedAt?.toISOString()).toBe(
        '2026-02-03T04:05:06.000Z',
      );
    });

    it('returns null for an account that does not exist rather than throwing', async () => {
      const repository = await create();
      expect(await repository.findById('33333333-3333-4333-8333-333333333333')).toBeNull();
      expect(await repository.findByEmail('nobody@example.com')).toBeNull();
      expect(await repository.findBySocialIdentity({ provider: 'google', subject: 'x' })).toBeNull();
    });
  });
}

contractFor('in-memory double', () => createInMemoryAccountRepository());

if (connectionString === undefined) {
  describe.skip('AccountRepository contract — PostgreSQL (no MUSICSTUDIO_DATABASE_URL)', () => {
    it('runs in the CI database job', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const client = new Client({ connectionString });

  beforeAll(async () => {
    await client.connect();
    const executor: SqlExecutor = {
      query: async (sql: string) => ({ rows: (await client.query(sql)).rows }),
    };
    await applyMigrations(executor, loadMigrations());
  });

  afterEach(async () => {
    // `account_social_identity` cascades from `account`, so one truncate empties both — and if the
    // foreign key were ever dropped this test would start failing on leftover rows, which is the
    // right way to find that out.
    await client.query('TRUNCATE account CASCADE');
  });

  afterAll(async () => {
    await client.end();
  });

  contractFor('PostgreSQL', () => createPgAccountRepository(client));
}
