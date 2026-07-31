-- 0002 — Account (design §4.1).
--
-- Authentication and credit behaviour are tasks 1.2 and 1.4; this migration only
-- creates the stored shape they will use.

CREATE TABLE account (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    password_hash text NOT NULL,
    plan_id text NOT NULL DEFAULT 'free',
    credit_balance integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT account_email_shape CHECK (
        email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        AND char_length(email) BETWEEN 3 AND 320
    ),
    CONSTRAINT account_password_hash_present CHECK (char_length(password_hash) > 0),
    CONSTRAINT account_plan_id_present CHECK (char_length(plan_id) BETWEEN 1 AND 64),
    -- Requirement 2: a balance may reach zero but never go negative.
    CONSTRAINT account_credit_balance_non_negative CHECK (credit_balance >= 0)
);

-- Identity is the address case-folded, matching `normaliseEmail` in
-- `domain/account.ts`.
CREATE UNIQUE INDEX account_email_lower_key ON account (lower(email));

COMMENT ON TABLE account IS 'Design §4.1 Account.';
