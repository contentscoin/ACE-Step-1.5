/**
 * Account persistence port.
 *
 * Deliberately narrow: it exposes only the four lookups and three mutations
 * Requirement 1 needs. The PostgreSQL `Account` table (task 1.1, design §4.1)
 * backs it in production; `test/support` backs it in memory for tests, so this
 * layer carries no assumption about the physical schema beyond these fields.
 */
export interface SocialIdentity {
  readonly provider: string;
  readonly subject: string;
}

export interface AccountRecord {
  readonly id: string;
  /** Normalised (lower-cased, trimmed) address — see `normalizeEmail`. */
  readonly email: string;
  /**
   * bcrypt hash with work factor >= 12, or `null` for accounts that only ever
   * authenticated through a social provider (Requirement 1.6, 1.7).
   */
  readonly passwordHash: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly socialIdentities: readonly SocialIdentity[];
}

export interface NewAccount {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly socialIdentities: readonly SocialIdentity[];
}

export interface AccountRepository {
  findById(accountId: string): Promise<AccountRecord | null>;
  findByEmail(email: string): Promise<AccountRecord | null>;
  findBySocialIdentity(identity: SocialIdentity): Promise<AccountRecord | null>;

  /**
   * Inserts a new account.
   *
   * Implementations MUST reject a duplicate address by throwing the
   * `email_already_registered` AccountError (Requirement 1.2). This is the
   * authoritative uniqueness check: a caller-side pre-check cannot close the
   * race between two concurrent signups, so the unique constraint is what the
   * behaviour is pinned to.
   */
  create(account: NewAccount): Promise<AccountRecord>;

  linkSocialIdentity(accountId: string, identity: SocialIdentity): Promise<void>;
  markEmailVerified(accountId: string, verifiedAt: Date): Promise<void>;
}
