-- 0019 — what `AccountRepository` needs and 0002 could not store (Requirements 1.6, 1.7).
--
-- `services/account/account-repository.ts` has always described an account with a
-- nullable password hash, a verification timestamp and a list of social identities.
-- Nothing checked that against the table, because until now nothing read the table:
-- every implementation of the port was the in-memory double. The three gaps:
--
--   * `password_hash` was NOT NULL with a non-empty CHECK, so an account that only
--     ever signed in through Google or Apple — `passwordHash: null` in the port,
--     Requirement 1.7 — had no representable form. The alternative that suggests
--     itself, storing a sentinel string, is worse: a hash column holding a value
--     that is not a hash is one careless `bcrypt.compare` away from an account
--     anybody can log into.
--   * There was no column for the verification link's outcome. Requirement 1.1
--     sends the link; the answer had nowhere to land.
--   * There was no home for social identities at all.
--
-- No data migration accompanies this. The table has no production rows anywhere —
-- there has never been an adapter to write one.

-- A password hash is now absent-or-present, and the CHECK constrains only the
-- present case. `char_length(...) > 0` on a NULL is NULL, not false, so a bare
-- relaxation of NOT NULL would already have admitted NULL; it is restated here so
-- the intent is legible rather than inferred from three-valued logic.
ALTER TABLE account ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE account DROP CONSTRAINT account_password_hash_present;
ALTER TABLE account ADD CONSTRAINT account_password_hash_present CHECK (
    password_hash IS NULL OR char_length(password_hash) > 0
);

-- An account with no verified address is the normal state between signup and the
-- click on the link, so this is nullable and has no default.
ALTER TABLE account ADD COLUMN email_verified_at timestamptz;

-- One row per (provider, subject) the account has authenticated with.
--
-- A table rather than a JSON column on `account`: the lookup that matters is
-- `findBySocialIdentity` — given a provider and a subject, which account is this? —
-- and that is an index on two columns here versus a scan with a containment
-- operator there.
CREATE TABLE account_social_identity (
    account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    provider text NOT NULL,
    subject text NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),

    -- The subject is the provider's own identifier for the user. Bounded because
    -- an unbounded key is an unbounded index entry.
    CONSTRAINT account_social_identity_provider_present CHECK (
        char_length(provider) BETWEEN 1 AND 64
    ),
    CONSTRAINT account_social_identity_subject_present CHECK (
        char_length(subject) BETWEEN 1 AND 255
    ),

    -- Requirement 1.7's uniqueness, and the reason it is the primary key rather
    -- than a secondary index: one Google subject identifies one account. Were two
    -- accounts allowed to claim it, a social login would have to choose between
    -- them, and there is no correct choice to make at that point.
    PRIMARY KEY (provider, subject)
);

-- The other direction: every identity linked to one account, for reading a record
-- back. Without it, loading an account scans the table.
CREATE INDEX account_social_identity_account_id_idx
    ON account_social_identity (account_id);

COMMENT ON TABLE account_social_identity IS
    'Design §4.1 Account social identities (Requirement 1.7).';
