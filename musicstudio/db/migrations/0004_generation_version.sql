-- 0004 — Generation_Version (design §4.1).
--
-- Structural rules only: one default version and one original version per asset.
-- The 16-version cap, default promotion and effect-chain semantics are
-- Effects_Service behaviour (Requirement 29, task 3.2).

CREATE TABLE generation_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    name text NOT NULL,
    effect_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
    derived_from_version_id uuid REFERENCES generation_version (id) ON DELETE SET NULL,
    is_default boolean NOT NULL DEFAULT false,
    is_original boolean NOT NULL DEFAULT false,
    duration_ms integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT generation_version_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT generation_version_duration_range CHECK (duration_ms BETWEEN 1 AND 3600000),
    CONSTRAINT generation_version_effect_chain_array CHECK (
        jsonb_typeof(effect_chain) = 'array'
    ),
    CONSTRAINT generation_version_not_self_derived CHECK (derived_from_version_id <> id),
    -- Requirement 29: the original is never the product of an effect chain.
    CONSTRAINT generation_version_original_has_no_chain CHECK (
        NOT is_original OR effect_chain = '[]'::jsonb
    )
);

-- Exactly one default and one original per asset.
CREATE UNIQUE INDEX generation_version_one_default_per_asset
    ON generation_version (asset_id)
    WHERE is_default;

CREATE UNIQUE INDEX generation_version_one_original_per_asset
    ON generation_version (asset_id)
    WHERE is_original;

CREATE INDEX generation_version_asset_idx ON generation_version (asset_id, created_at);

COMMENT ON TABLE generation_version IS
    'Design §4.1 Generation_Version. Version count cap (Requirement 29) is enforced by Effects_Service.';
