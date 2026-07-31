import type {
  AccountRecord,
  AccountRepository,
  NewAccount,
  SocialIdentity,
} from '../../services/account/account-repository';
import { normalizeEmail } from '../../services/account/email';
import { emailAlreadyRegistered } from '../../services/account/errors';

/**
 * In-memory `AccountRepository`.
 *
 * Stands in for the PostgreSQL `Account` table until task 1.1 lands. It
 * reproduces the one behaviour the domain depends on: `create` rejects a
 * duplicate address with the `email_already_registered` error, mirroring the
 * unique constraint the real schema will carry (Requirement 1.2).
 */
export interface InMemoryAccountRepository extends AccountRepository {
  readonly size: number;
}

export function createInMemoryAccountRepository(
  seed: readonly AccountRecord[] = [],
): InMemoryAccountRepository {
  const byId = new Map<string, AccountRecord>(seed.map((record) => [record.id, record]));

  const findByEmail = (email: string): AccountRecord | null => {
    const normalized = normalizeEmail(email);
    for (const record of byId.values()) {
      if (record.email === normalized) {
        return record;
      }
    }
    return null;
  };

  const requireById = (accountId: string): AccountRecord => {
    const record = byId.get(accountId);
    if (record === undefined) {
      throw new Error(`Unknown account ${accountId}`);
    }
    return record;
  };

  return {
    get size() {
      return byId.size;
    },

    async findById(accountId) {
      return byId.get(accountId) ?? null;
    },

    async findByEmail(email) {
      return findByEmail(email);
    },

    async findBySocialIdentity(identity: SocialIdentity) {
      for (const record of byId.values()) {
        const match = record.socialIdentities.some(
          (candidate) =>
            candidate.provider === identity.provider && candidate.subject === identity.subject,
        );
        if (match) {
          return record;
        }
      }
      return null;
    },

    async create(account: NewAccount) {
      const email = normalizeEmail(account.email);
      if (findByEmail(email) !== null) {
        throw emailAlreadyRegistered(email);
      }
      const record: AccountRecord = { ...account, email };
      byId.set(record.id, record);
      return record;
    },

    async linkSocialIdentity(accountId, identity) {
      const record = requireById(accountId);
      byId.set(accountId, {
        ...record,
        socialIdentities: [...record.socialIdentities, identity],
      });
    },

    async markEmailVerified(accountId, verifiedAt) {
      const record = requireById(accountId);
      byId.set(accountId, { ...record, emailVerifiedAt: verifiedAt });
    },
  };
}
