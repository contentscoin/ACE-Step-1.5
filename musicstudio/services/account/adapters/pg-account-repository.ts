/**
 * `AccountRepository` over PostgreSQL — the first adapter that reads the schema
 * (`docs/ROADMAP.md` track B1).
 *
 * Until this existed the port had exactly one implementation, the in-memory double, and the
 * eighteen migrations were applied by CI and read by nothing. That arrangement hides a specific
 * class of defect: the double and the table can describe different shapes indefinitely, because
 * nothing ever makes them meet. It did. `0019_account_identity.sql` is what the meeting produced —
 * the table had no nullable password hash, no verification column and no social identities, all
 * three of which the port has always promised.
 *
 * ### The pool is injected, not constructed
 *
 * A module that builds its own pool decides for every caller how many connections to hold and when
 * to end them, and gives a test no way to run against a transaction it can roll back. The caller
 * owns the lifetime; this file owns the SQL.
 *
 * ### Uniqueness is the constraint's answer, not a pre-check
 *
 * `create` does not look before it inserts. Requirement 1.2 refuses a duplicate address, and two
 * concurrent signups for the same address both pass a `SELECT` and then both `INSERT`; only the
 * unique index decides. So the insert runs and `23505` is translated. The pre-check version passes
 * its tests and fails in production, which is the worst available combination.
 */

import type {
  AccountRecord,
  AccountRepository,
  NewAccount,
  SocialIdentity,
} from '../account-repository';
import { normalizeEmail } from '../email';
import { emailAlreadyRegistered } from '../errors';

/**
 * The slice of `pg` this adapter uses.
 *
 * Declared structurally rather than importing `Pool`, so `db/` stays driver-agnostic in the same
 * way `db/runner.ts` does and a test can pass a client, a pool or a transaction-scoped handle —
 * all three satisfy this shape and each is the right one somewhere.
 */
export interface PgQueryable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The index that carries Requirement 1.2, named so a different collision is not mistaken for it. */
const EMAIL_UNIQUE_INDEX = 'account_email_lower_key';

interface AccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string | null;
  readonly email_verified_at: Date | null;
  readonly created_at: Date;
}

interface IdentityRow extends Record<string, unknown> {
  readonly provider: string;
  readonly subject: string;
}

function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint;
}

export function createPgAccountRepository(db: PgQueryable): AccountRepository {
  /**
   * The identities linked to one account.
   *
   * Ordered by `linked_at` so a record reads back in the order the links were made — the port
   * returns a list, and an unordered one would differ between two reads of the same account for
   * no reason a caller could act on.
   */
  async function identitiesFor(accountId: string): Promise<readonly SocialIdentity[]> {
    const { rows } = await db.query<IdentityRow>(
      `SELECT provider, subject
         FROM account_social_identity
        WHERE account_id = $1
        ORDER BY linked_at, provider, subject`,
      [accountId],
    );
    return rows.map((row) => ({ provider: row.provider, subject: row.subject }));
  }

  async function toRecord(row: AccountRow): Promise<AccountRecord> {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.created_at,
      socialIdentities: await identitiesFor(row.id),
    };
  }

  async function firstRecord(rows: readonly AccountRow[]): Promise<AccountRecord | null> {
    const row = rows[0];
    return row === undefined ? null : await toRecord(row);
  }

  const SELECT_ACCOUNT = `SELECT id, email, password_hash, email_verified_at, created_at FROM account`;

  return {
    async findById(accountId) {
      const { rows } = await db.query<AccountRow>(`${SELECT_ACCOUNT} WHERE id = $1`, [accountId]);
      return firstRecord(rows);
    },

    async findByEmail(email) {
      // `lower(email)` rather than `email = $1`, matching `account_email_lower_key`. Comparing the
      // raw column would miss a stored address whose casing differs and would not use the index —
      // and the two failures are the same failure: a second account on one address.
      const { rows } = await db.query<AccountRow>(`${SELECT_ACCOUNT} WHERE lower(email) = $1`, [
        normalizeEmail(email),
      ]);
      return firstRecord(rows);
    },

    async findBySocialIdentity(identity) {
      const { rows } = await db.query<AccountRow>(
        `SELECT a.id, a.email, a.password_hash, a.email_verified_at, a.created_at
           FROM account a
           JOIN account_social_identity i ON i.account_id = a.id
          WHERE i.provider = $1 AND i.subject = $2`,
        [identity.provider, identity.subject],
      );
      return firstRecord(rows);
    },

    async create(account: NewAccount) {
      const email = normalizeEmail(account.email);

      let inserted: AccountRow | undefined;
      try {
        const { rows } = await db.query<AccountRow>(
          `INSERT INTO account (id, email, password_hash, email_verified_at, created_at)
                VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, password_hash, email_verified_at, created_at`,
          [account.id, email, account.passwordHash, account.emailVerifiedAt, account.createdAt],
        );
        inserted = rows[0];
      } catch (error) {
        // Only the address collision becomes Requirement 1.2's refusal. A collision on the social
        // identity key is a different fact with a different remedy, and reporting it as "this
        // e-mail is taken" would send the user to change the one thing that was fine.
        if (isUniqueViolationOn(error, EMAIL_UNIQUE_INDEX)) throw emailAlreadyRegistered(email);
        throw error;
      }

      if (inserted === undefined) throw new Error('account insert returned no row');

      for (const identity of account.socialIdentities) {
        await db.query(
          `INSERT INTO account_social_identity (account_id, provider, subject)
                VALUES ($1, $2, $3)`,
          [inserted.id, identity.provider, identity.subject],
        );
      }

      return toRecord(inserted);
    },

    async linkSocialIdentity(accountId, identity) {
      // A plain insert, with no `ON CONFLICT`. `SocialLoginService` reaches here only after
      // `findBySocialIdentity` returned null, so the row is known absent; a unique violation at
      // this point means two logins raced for the same subject, and that is worth surfacing rather
      // than swallowing. `DO NOTHING` would report success for a link that went to another account.
      await db.query(
        `INSERT INTO account_social_identity (account_id, provider, subject) VALUES ($1, $2, $3)`,
        [accountId, identity.provider, identity.subject],
      );
    },

    async markEmailVerified(accountId, verifiedAt) {
      await db.query(`UPDATE account SET email_verified_at = $2 WHERE id = $1`, [
        accountId,
        verifiedAt,
      ]);
    },
  };
}
