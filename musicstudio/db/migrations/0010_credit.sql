-- 0010 — Credit_Service: plans, unit prices and the credit ledger
-- (Requirements 2.1–2.14; design §2.4, §4.1, §4.4).
--
-- Redis holds the operational balance because Requirement 2.3 needs an atomic
-- guard-and-decrement (design §2.4). This schema holds what Redis must not be
-- trusted with: the durable, append-only history of every credit movement, and
-- the rate card and plan ceilings the service charges from.
--
-- The rules are stated once as pure functions and wrapped thinly here:
--
--   domain/credit/plan.ts          -> credit_plan, credit_plan_asset_cap seeds
--   domain/credit/pricing.ts       -> credit_price seed, cost formula comment
--   domain/credit/ledger-entry.ts  -> credit_ledger_entry CHECKs, append-only
--   domain/credit/usage.ts         -> credit_monthly_usage, credit_monthly_asset_usage
--
-- `test/unit/credit/schema-parity.test.ts` fails if the two sides drift, and it
-- needs no database.
--
-- Error class:
--   MS002 — credit and quota invariant (Requirement 2)

CREATE TYPE credit_entry_type AS ENUM (
    'initial_grant',
    'cycle_renewal',
    'charge',
    'refund'
);

COMMENT ON TYPE credit_entry_type IS
    'Requirement 2: signed credit movements. Mirrors domain/credit/ledger-entry.ts.';

CREATE TYPE charge_kind AS ENUM (
    'generation',
    'mixdown',
    'sound_pack'
);

COMMENT ON TYPE charge_kind IS
    'What a charge paid for. Requirement 2.12 mixdown and 2.13 Sound_Pack are their own kinds.';

-- Requirements 2.1, 2.5, 2.8: one row per plan carries every ceiling.
CREATE TABLE credit_plan (
    plan_id text PRIMARY KEY,
    initial_credits integer NOT NULL,
    monthly_credits integer NOT NULL,
    max_jobs_per_month integer NOT NULL,
    max_concurrent_jobs integer NOT NULL,

    CONSTRAINT credit_plan_initial_credits_non_negative CHECK (initial_credits >= 0),
    CONSTRAINT credit_plan_monthly_credits_non_negative CHECK (monthly_credits >= 0),
    CONSTRAINT credit_plan_max_jobs_positive CHECK (max_jobs_per_month > 0),
    CONSTRAINT credit_plan_max_concurrent_positive CHECK (max_concurrent_jobs > 0)
);

COMMENT ON TABLE credit_plan IS 'Requirements 2.1, 2.5, 2.8. Mirrors domain/credit/plan.ts.';

INSERT INTO credit_plan
    (plan_id, initial_credits, monthly_credits, max_jobs_per_month, max_concurrent_jobs)
VALUES
    ('free', 100, 100, 30, 1),
    ('creator', 2000, 2000, 500, 3),
    ('studio', 10000, 10000, 3000, 8);

-- Requirement 2.14: every plan has an explicit ceiling for every Asset_Kind, so
-- an unlisted kind is a schema error rather than an unlimited allowance.
CREATE TABLE credit_plan_asset_cap (
    plan_id text NOT NULL REFERENCES credit_plan (plan_id) ON DELETE CASCADE,
    asset_kind asset_kind NOT NULL,
    max_assets_per_month integer NOT NULL,

    PRIMARY KEY (plan_id, asset_kind),
    CONSTRAINT credit_plan_asset_cap_positive CHECK (max_assets_per_month > 0)
);

COMMENT ON TABLE credit_plan_asset_cap IS
    'Requirement 2.14 per-Asset_Kind monthly ceiling. Mirrors PlanDefinition.maxMonthlyAssetsByKind.';

INSERT INTO credit_plan_asset_cap (plan_id, asset_kind, max_assets_per_month)
VALUES
    ('free', 'song', 10),
    ('free', 'bgm', 10),
    ('free', 'sfx', 20),
    ('free', 'dialogue', 10),
    ('free', 'stem', 5),
    ('free', 'mix', 5),
    ('creator', 'song', 200),
    ('creator', 'bgm', 200),
    ('creator', 'sfx', 400),
    ('creator', 'dialogue', 200),
    ('creator', 'stem', 100),
    ('creator', 'mix', 100),
    ('studio', 'song', 1000),
    ('studio', 'bgm', 1000),
    ('studio', 'sfx', 2000),
    ('studio', 'dialogue', 1000),
    ('studio', 'stem', 500),
    ('studio', 'mix', 500);

-- Requirement 2.9: the unit-price table, keyed by Asset_Kind x Engine_Descriptor.
-- Cost is integer-only, exactly as domain/credit/pricing.ts computes it:
--   cost = output_count * (base_credits + ceil(duration_ms * credits_per_second / 1000))
CREATE TABLE credit_price (
    asset_kind asset_kind NOT NULL,
    engine_id text NOT NULL,
    base_credits integer NOT NULL,
    credits_per_second integer NOT NULL,

    PRIMARY KEY (asset_kind, engine_id),
    CONSTRAINT credit_price_engine_id_present CHECK (char_length(engine_id) BETWEEN 1 AND 64),
    CONSTRAINT credit_price_base_non_negative CHECK (base_credits >= 0),
    CONSTRAINT credit_price_per_second_non_negative CHECK (credits_per_second >= 0),
    -- A priced combination must cost something; free GPU time defeats Req 2.
    CONSTRAINT credit_price_positive CHECK (base_credits + credits_per_second > 0)
);

COMMENT ON TABLE credit_price IS
    'Requirement 2.9 unit-price table. Mirrors services/credit/pricing-table.ts.';

INSERT INTO credit_price (asset_kind, engine_id, base_credits, credits_per_second)
VALUES
    ('song', 'ace-step-1.5', 8, 1),
    ('bgm', 'ace-step-1.5', 4, 1),
    ('sfx', 'woosh-flow', 2, 2),
    ('sfx', 'ace-step-1.5', 3, 2),
    ('dialogue', 'tts-engine-a', 1, 1),
    ('dialogue', 'tts-engine-b', 1, 1),
    ('stem', 'ace-step-1.5', 6, 1),
    ('mix', 'mixdown-renderer', 2, 1);

-- Requirement 2.9 coverage: no Asset_Kind may be left unpriced, or a request for
-- it would be unchargeable rather than rejected by Requirement 2.11.
DO $$
DECLARE
    v_unpriced text;
BEGIN
    SELECT string_agg(k.kind::text, ', ') INTO v_unpriced
    FROM (SELECT unnest(enum_range(NULL::asset_kind)) AS kind) k
    WHERE NOT EXISTS (SELECT 1 FROM credit_price p WHERE p.asset_kind = k.kind);

    IF v_unpriced IS NOT NULL THEN
        RAISE EXCEPTION 'Requirement 2.9: no credit price registered for Asset_Kind(s) %',
            v_unpriced
            USING ERRCODE = 'MS002';
    END IF;
END;
$$;

-- The credit ledger (Requirements 2.2, 2.4, 2.7, 2.8).
--
-- One row per movement with a signed amount, so the balance is a fold and no
-- history is ever rewritten. Append-only, like audit_log: a refund is a new row,
-- never an edit of the charge.
CREATE TABLE credit_ledger_entry (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    entry_id uuid NOT NULL UNIQUE,
    account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    entry_type credit_entry_type NOT NULL,
    amount integer NOT NULL,
    job_id text,
    charge_kind charge_kind,
    asset_kind asset_kind,
    engine_id text,
    duration_ms integer,
    output_count integer,
    reason text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),

    -- Sign follows the entry type (domain/credit/ledger-entry.ts).
    CONSTRAINT credit_ledger_entry_amount_sign CHECK (
        (entry_type IN ('initial_grant', 'cycle_renewal', 'refund') AND amount >= 0)
        OR (entry_type = 'charge' AND amount <= 0)
    ),
    CONSTRAINT credit_ledger_entry_charge_has_job CHECK (
        entry_type NOT IN ('charge', 'refund') OR job_id IS NOT NULL
    ),
    CONSTRAINT credit_ledger_entry_grant_has_no_job CHECK (
        entry_type NOT IN ('initial_grant', 'cycle_renewal') OR job_id IS NULL
    ),
    CONSTRAINT credit_ledger_entry_output_count_positive CHECK (
        output_count IS NULL OR output_count > 0
    ),
    CONSTRAINT credit_ledger_entry_duration_non_negative CHECK (
        duration_ms IS NULL OR duration_ms >= 0
    ),
    CONSTRAINT credit_ledger_entry_reason_present CHECK (char_length(reason) BETWEEN 1 AND 128)
);

COMMENT ON TABLE credit_ledger_entry IS
    'Requirement 2: append-only signed credit movements. Balance is the fold of this table.';

-- Requirements 2.2 and 2.4 exactly once per job: one charge, at most one refund.
-- This index, not an application check, is what closes the double-submit race.
CREATE UNIQUE INDEX credit_ledger_entry_job_once
    ON credit_ledger_entry (job_id, entry_type)
    WHERE job_id IS NOT NULL;

CREATE INDEX credit_ledger_entry_account_time_idx
    ON credit_ledger_entry (account_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION credit_ledger_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'credit_ledger_entry is append-only (Requirement 2): % is not permitted',
        TG_OP
        USING ERRCODE = 'MS002';
END;
$$;

CREATE TRIGGER credit_ledger_entry_no_update
    BEFORE UPDATE ON credit_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION credit_ledger_reject_mutation();

CREATE TRIGGER credit_ledger_entry_no_delete
    BEFORE DELETE ON credit_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION credit_ledger_reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON credit_ledger_entry FROM PUBLIC;

-- A refund may only follow a charge for the same job, and only for its full
-- amount (Requirement 2.4). Enforced at insert time because the ledger cannot be
-- corrected afterwards.
CREATE OR REPLACE FUNCTION credit_ledger_validate_refund()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_charged integer;
BEGIN
    SELECT -amount INTO v_charged
    FROM credit_ledger_entry
    WHERE job_id = NEW.job_id AND entry_type = 'charge';

    IF v_charged IS NULL THEN
        RAISE EXCEPTION 'Requirement 2.4: refund for job % has no matching charge', NEW.job_id
            USING ERRCODE = 'MS002',
                  DETAIL = json_build_object('jobId', NEW.job_id)::text;
    END IF;

    IF NEW.amount <> v_charged THEN
        RAISE EXCEPTION
            'Requirement 2.4: refund must return the full charged amount (% credits), not %',
            v_charged, NEW.amount
            USING ERRCODE = 'MS002',
                  DETAIL = json_build_object(
                      'jobId', NEW.job_id,
                      'chargedAmount', v_charged,
                      'refundAmount', NEW.amount
                  )::text;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER credit_ledger_entry_refund_matches_charge
    BEFORE INSERT ON credit_ledger_entry
    FOR EACH ROW
    WHEN (NEW.entry_type = 'refund')
    EXECUTE FUNCTION credit_ledger_validate_refund();

-- Billing period in force (Requirement 2.8): the newest period-opening entry.
CREATE VIEW credit_current_period AS
SELECT account_id, max(occurred_at) AS period_start
FROM credit_ledger_entry
WHERE entry_type IN ('initial_grant', 'cycle_renewal')
GROUP BY account_id;

COMMENT ON VIEW credit_current_period IS
    'Requirement 2.8: a renewal opens a new period, which is what zeroes the monthly aggregate.';

-- Requirement 2.7. A refunded job counts for nothing: Requirement 2.4 returns the
-- full amount, so it consumed neither credits nor a job slot for the month.
CREATE VIEW credit_monthly_usage AS
SELECT
    p.account_id,
    p.period_start,
    coalesce(sum(-e.amount), 0)::bigint AS credits_used,
    count(e.id)::bigint AS jobs_charged
FROM credit_current_period p
LEFT JOIN credit_ledger_entry e
       ON e.account_id = p.account_id
      AND e.entry_type = 'charge'
      AND e.occurred_at >= p.period_start
      AND NOT EXISTS (
              SELECT 1 FROM credit_ledger_entry r
               WHERE r.job_id = e.job_id AND r.entry_type = 'refund'
          )
GROUP BY p.account_id, p.period_start;

COMMENT ON VIEW credit_monthly_usage IS
    'Requirement 2.7 balance-independent aggregate. Mirrors summariseUsage in domain/credit/usage.ts.';

-- Requirement 2.14 usage side of the ceiling.
CREATE VIEW credit_monthly_asset_usage AS
SELECT
    p.account_id,
    p.period_start,
    e.asset_kind,
    coalesce(sum(e.output_count), 0)::bigint AS outputs
FROM credit_current_period p
JOIN credit_ledger_entry e
       ON e.account_id = p.account_id
      AND e.entry_type = 'charge'
      AND e.occurred_at >= p.period_start
      AND e.asset_kind IS NOT NULL
      AND NOT EXISTS (
              SELECT 1 FROM credit_ledger_entry r
               WHERE r.job_id = e.job_id AND r.entry_type = 'refund'
          )
GROUP BY p.account_id, p.period_start, e.asset_kind;

COMMENT ON VIEW credit_monthly_asset_usage IS
    'Requirement 2.14 per-Asset_Kind monthly usage.';

-- Reconciliation: the ledger fold is the truth, `account.credit_balance` is the
-- cached projection of it, and Redis is the operational copy. Drift between the
-- two durable sides shows up here instead of in a support ticket.
--
-- Nothing in this migration writes `account.credit_balance`: the operational
-- balance lives in Redis (Requirement 2.3 needs an atomic decrement, which a row
-- update cannot give without a lock). Keeping the cached column in step is the
-- job of the projection that consumes this ledger, and this view is how that job
-- is held to account.
CREATE VIEW account_credit_balance AS
SELECT
    a.id AS account_id,
    a.plan_id,
    a.credit_balance AS cached_balance,
    coalesce(sum(e.amount), 0)::bigint AS ledger_balance
FROM account a
LEFT JOIN credit_ledger_entry e ON e.account_id = a.id
GROUP BY a.id, a.plan_id, a.credit_balance;

CREATE VIEW account_credit_balance_violation AS
SELECT account_id, plan_id, cached_balance, ledger_balance
FROM account_credit_balance
WHERE cached_balance <> ledger_balance;

COMMENT ON VIEW account_credit_balance_violation IS
    'Requirement 2 reconciliation query: holds iff this view returns no rows.';
