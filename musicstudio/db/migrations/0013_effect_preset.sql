-- 0013 — Effect_Preset (Requirements 29.21, 29.22, 29.23, 29.35).
--
-- Thin wrapper over the rules stated in `domain/effects/`. Same name bound, same
-- chain shape, same per-user cap:
--
--   name bound (1–60)       domain/effects/registry.ts  EFFECT_NAME_*_LENGTH
--   chain item count (1–16) domain/effects/registry.ts  CHAIN_ITEM_COUNT_*
--   per-user cap (100)      domain/effects/registry.ts  MAX_PRESETS_PER_USER
--   built-in ids            domain/effects/preset.ts    BUILT_IN_PRESET_IDS
--
-- `test/unit/effects/preset-schema-parity.test.ts` fails if the two sides drift, and it
-- needs no database — the same arrangement as `0012`'s parity suite.
--
-- ### Why built-ins are not rows
--
-- Requirement 29.21's four built-in presets live in `domain/effects/preset.ts` as
-- constants and are **not** seeded here. They are code, not data: their chains are
-- fixed by the product, Requirement 29.23 makes them immutable, and a row that could
-- be UPDATEd is a worse guarantee of immutability than a constant that cannot. Seeding
-- them would also make `owner_id` nullable, and the partial-unique-index arrangement
-- that a nullable owner needs would weaken the per-user rules below for no gain.
--
-- Consequence, made explicit: `owner_id` is NOT NULL, so every row in this table is a
-- user preset and `COUNT(*)` per owner is exactly Requirement 29.35's subject. No
-- `WHERE owner_id IS NOT NULL` is needed anywhere.
--
-- ### What is *not* here
--
-- - The 100-preset cap is **not** a SQL constraint. Postgres cannot express "at most N
--   rows per owner" declaratively, and the trigger that could would fire per statement
--   while the decision belongs to `services/effects/preset-service.ts`, which must
--   return the current count and the limit (29.35) rather than raise. The column
--   comment records the number so a reader of the schema is not left guessing.
-- - Per-parameter range checks (29.2–29.8) are not CHECKed either. They are per-kind,
--   so expressing them in SQL means eight nested `jsonb` case analyses that would then
--   be a second declaration of `effect_registry.json` — the one thing the two-language
--   parity test exists to prevent. `chainViolations` gates every write.

CREATE TABLE effect_preset (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Requirement 29.22: "요청자 소유 프리셋". Never null — see the header.
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    name text NOT NULL,
    chain jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- Requirement 29.22's name bound. Narrower than `generation_version.name`'s 1–200
    -- (migration 0004), which is deliberate: 0004 predates Requirement 29 and its
    -- column is the storage bound, while 60 is what Requirement 29.20/29.22 allow a
    -- user to send. See `services/effects/version-manager.ts`.
    CONSTRAINT effect_preset_name_length CHECK (char_length(name) BETWEEN 1 AND 60),

    -- Requirement 29.11: an order-preserving JSON array.
    CONSTRAINT effect_preset_chain_array CHECK (jsonb_typeof(chain) = 'array'),

    -- Requirement 29.13 / 29.22: 1–16 items.
    CONSTRAINT effect_preset_chain_item_count CHECK (
        jsonb_array_length(chain) BETWEEN 1 AND 16
    ),

    -- Every item is an object carrying both keys. Structure only; the kind vocabulary
    -- and the parameter ranges are the registry's (see the header).
    --
    -- Written as a SQL/JSON path rather than the `NOT EXISTS (SELECT … FROM
    -- jsonb_array_elements(chain))` it started as, because **PostgreSQL forbids a subquery
    -- in a CHECK constraint** — `0A000: cannot use subquery in check constraint`. That is
    -- not a preference this migration can argue with, and the original form meant migration
    -- 0013 could never be applied. It was never caught because the migration suite is
    -- skipped without a database, which is the thing task 9.3 stopped being true.
    --
    -- `jsonb_path_exists` is an ordinary function call, so it is legal here. The path finds
    -- any element that *fails* the shape, and the constraint holds when there is none.
    -- `!exists(@.kind)` is separate from the type test on purpose: an absent key yields no
    -- item, so a filter that only compared types would accept `{"parameters": {}}`.
    CONSTRAINT effect_preset_chain_items_shaped CHECK (
        NOT jsonb_path_exists(
            chain,
            '$[*] ? (@.type() != "object"
                  || !exists(@.kind) || @.kind.type() != "string"
                  || !exists(@.parameters) || @.parameters.type() != "object")'
        )
    ),

    -- Requirement 29.23: a user preset can never collide with a built-in identifier,
    -- so an update aimed at a built-in cannot be redirected to a row.
    CONSTRAINT effect_preset_not_builtin_name CHECK (id::text NOT LIKE 'builtin\_%')
);

-- Requirement 29.22: one name per owner. Not required by the clause, but a duplicate
-- name is indistinguishable in a picker and the alternative is a user with four
-- presets called "Vocal".
CREATE UNIQUE INDEX effect_preset_owner_name_unique ON effect_preset (owner_id, lower(name));

-- Requirement 29.35's counting query, and the owner's list view.
CREATE INDEX effect_preset_owner_idx ON effect_preset (owner_id, created_at);

COMMENT ON TABLE effect_preset IS
    'Design §4.1 Effect_Preset (Requirement 29.22). Built-in presets are constants in domain/effects/preset.ts, not rows.';
COMMENT ON COLUMN effect_preset.owner_id IS
    'Requirement 29.35: at most 100 rows per owner, enforced by services/effects/preset-service.ts.';
COMMENT ON COLUMN effect_preset.chain IS
    'Effect_Chain as printed by Chain_Printer (Requirement 29.24). Parameter ranges are validated by domain/effects.';
