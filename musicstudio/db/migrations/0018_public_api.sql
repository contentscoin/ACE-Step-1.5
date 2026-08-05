-- 0018 — the developer Public_API: keys and webhook endpoints (Requirement 17).
--
-- Bounds and vocabularies mirror `domain/public-api/`, and
-- `test/unit/public-api/schema-parity.test.ts` fails if the two drift:
--
--   key prefix (`ms_live_`)        domain/public-api/api-key.ts    API_KEY_PREFIX
--   fingerprint chars (6)          domain/public-api/api-key.ts    API_KEY_FINGERPRINT_CHARS
--   label bound (1–60)             domain/public-api/api-key.ts    API_KEY_LABEL_MAX_LENGTH
--   webhook URL bound (2000)       domain/public-api/webhook.ts    WEBHOOK_URL_MAX_LENGTH
--   requests per minute (60)       domain/public-api/rate-limit.ts DEFAULT_REQUESTS_PER_MINUTE
--
-- ### There is no column for the key
--
-- Requirement 17.2 says 단방향 해시 형태로만 저장, and the way to make that true is to have
-- nowhere to put the plaintext. `key_hash` is the credential; `fingerprint` is the handle
-- Requirement 17.9's revocation is addressed by. A `key text` column here would be the one
-- change that makes a database dump a set of live credentials, so it does not exist and the
-- parity test asserts its absence rather than trusting the reviewer to notice.
--
-- ### Revocation is a timestamp, not a boolean
--
-- 17.9 rejects requests *after* revocation, so what is stored is when. It also means a key is
-- never un-revoked: the row keeps its history, and the fix for a leaked key is a new key.

CREATE TABLE api_key (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,

    -- Requirement 17.2. SHA-256 hex of the key, and the only form of it that is kept.
    -- UNIQUE because authentication looks the key up by hash and nothing else: two rows with
    -- the same hash would be one credential with two identities.
    key_hash text NOT NULL UNIQUE,

    -- Requirement 17.9's handle: `ms_live_` plus the first six characters of the secret.
    -- Shown in a list, useless as a credential.
    fingerprint text NOT NULL,

    label text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Requirement 17.9. NULL means live; a value means dead from that instant.
    revoked_at timestamptz,

    -- Requirement 17.7's per-key ceiling. On the key rather than in configuration, because a
    -- limit that cannot differ per key would make every key's ceiling a deployment change.
    requests_per_minute integer NOT NULL DEFAULT 60,

    CONSTRAINT api_key_hash_is_sha256_hex CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT api_key_fingerprint_shape CHECK (fingerprint ~ '^ms_live_[A-Za-z0-9_-]{6}$'),
    CONSTRAINT api_key_label_length CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
    CONSTRAINT api_key_rate_limit_positive CHECK (requests_per_minute > 0)
);

-- Listing an account's keys (Requirement 17.9's "which one am I revoking"), newest first.
CREATE INDEX api_key_account_idx ON api_key (account_id, created_at DESC);

-- Requirements 17.10, 17.14 — where a completed job's result is sent.
--
-- One endpoint per key rather than per account: the key is what the integration authenticates
-- with, so it is the thing an integration owns. Two integrations on one account would
-- otherwise have to share a URL, and revoking one key would silently redirect the other.
CREATE TABLE webhook_endpoint (
    api_key_id uuid PRIMARY KEY REFERENCES api_key (id) ON DELETE CASCADE,
    url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT webhook_endpoint_url_length CHECK (char_length(url) BETWEEN 1 AND 2000),
    -- https only. A webhook body carries a customer's job results across a boundary this
    -- product does not control; plaintext is not a choice to leave to configuration.
    CONSTRAINT webhook_endpoint_url_https CHECK (url LIKE 'https://%')
);
