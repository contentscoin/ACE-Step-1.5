-- 0003 — Audio_Asset (design §4.1).
--
-- Requirements 19.1, 19.3, 19.4, 19.10, 19.11, 19.15 (stored-state constraints),
-- 33.7 / 33.14 (immutable provenance carrying the licence ruling and the AI
-- marker), 34.6 (Quality_Threshold_Set version), 4.3 (denormalised commercial-use
-- flag). Same rules as `domain/audio-asset.ts` and `domain/provenance.ts`.

CREATE TABLE audio_asset (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
    name text NOT NULL,
    asset_kind asset_kind NOT NULL,
    duration_ms integer NOT NULL,
    sample_rate integer NOT NULL DEFAULT 48000,
    channels smallint NOT NULL,
    engine_id text NOT NULL,
    -- Requirement 19.3: -1 is the fixed "engine supplied no seed" value.
    seed bigint NOT NULL DEFAULT -1,
    is_loop boolean NOT NULL DEFAULT false,

    -- Design §4.3: folded commercial-use flag, maintained at write time by
    -- 0007_commercial_use.sql. Never widened, only narrowed.
    commercial_use_allowed boolean NOT NULL DEFAULT false,

    -- Requirement 34.6: threshold set version used to admit the asset. NULL when
    -- the asset went through no quality gate (e.g. a plain upload).
    quality_threshold_set_version integer,

    -- Requirement 33.7: written once, never modified (enforced in 0007).
    provenance jsonb NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    is_deleted boolean NOT NULL DEFAULT false,
    deleted_at timestamptz,

    CONSTRAINT audio_asset_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
    -- Requirement 19.11.
    CONSTRAINT audio_asset_duration_range CHECK (duration_ms BETWEEN 1 AND 3600000),
    -- Requirement 19.4: storage is 48 kHz; 19.5 keeps the engine rate in provenance.
    CONSTRAINT audio_asset_sample_rate_canonical CHECK (sample_rate = 48000),
    CONSTRAINT audio_asset_channels_range CHECK (channels IN (1, 2)),
    CONSTRAINT audio_asset_engine_id_present CHECK (char_length(engine_id) BETWEEN 1 AND 128),
    CONSTRAINT audio_asset_seed_range CHECK (seed >= 0 OR seed = -1),
    -- Requirement 19.10: the loop flag only applies to bgm and sfx.
    CONSTRAINT audio_asset_loop_kind CHECK (
        NOT is_loop OR asset_kind IN ('bgm', 'sfx')
    ),
    CONSTRAINT audio_asset_quality_threshold_version_range CHECK (
        quality_threshold_set_version IS NULL OR quality_threshold_set_version >= 1
    ),
    -- Requirement 33.7: the five provenance fields are mandatory.
    CONSTRAINT audio_asset_provenance_shape CHECK (
        jsonb_typeof(provenance) = 'object'
        AND provenance ? 'engineId'
        AND provenance ? 'weightLicenseId'
        AND provenance ? 'attributionText'
        AND provenance ? 'commercialUseAllowed'
        AND provenance ? 'nonCommercialLicenseListVersion'
        AND provenance ? 'recordedAtMs'
        AND jsonb_typeof(provenance -> 'commercialUseAllowed') = 'boolean'
        AND char_length(provenance ->> 'attributionText') BETWEEN 1 AND 500
    ),
    -- Requirement 33.14: the AI-generation marker is part of the invariant.
    CONSTRAINT audio_asset_provenance_ai_generated CHECK (
        (provenance ->> 'aiGenerated')::boolean IS TRUE
    ),
    -- Design §4.3: the folded flag can never exceed the asset's own ruling.
    CONSTRAINT audio_asset_commercial_use_within_provenance CHECK (
        NOT commercial_use_allowed OR (provenance ->> 'commercialUseAllowed')::boolean
    ),
    CONSTRAINT audio_asset_deleted_at_consistent CHECK (
        (is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)
    )
);

CREATE INDEX audio_asset_owner_created_idx
    ON audio_asset (owner_id, created_at DESC)
    WHERE NOT is_deleted;

CREATE INDEX audio_asset_kind_idx ON audio_asset (asset_kind) WHERE NOT is_deleted;

COMMENT ON TABLE audio_asset IS
    'Design §4.1 / Requirement 19: one storage unit for song, bgm, sfx, dialogue, stem and mix.';
COMMENT ON COLUMN audio_asset.commercial_use_allowed IS
    'Design §4.3: folded over provenance, engines and all ancestors. Monotonically non-increasing.';
COMMENT ON COLUMN audio_asset.quality_threshold_set_version IS
    'Requirement 34.6: Quality_Threshold_Set version used to validate this asset.';
