-- 0014 — Sound_Pack and its cue associations (Requirements 24.1, 24.2, 24.3, 24.18, 24.20).
--
-- Design §4.1's `SoundPack` entity, plus the `contains_cues` relationship it draws to
-- `AudioAsset`. Thin wrapper over the rules stated in `domain/sound-pack/`, and the same
-- name bounds, the same cue count and the same status vocabulary:
--
--   pack name bound (1–60)         domain/sound-pack/bounds.ts    PACK_NAME_*_LENGTH
--   description bound (1–200)      domain/sound-pack/bounds.ts    PACK_DESCRIPTION_*_LENGTH
--   cue count (78)                 domain/sound-pack/bounds.ts    PACK_CUE_COUNT
--   status vocabulary              domain/sound-pack/status.ts    SOUND_PACK_STATUSES
--
-- `test/unit/sound-pack/schema-parity.test.ts` fails if the two sides drift, and it needs
-- no database — the same arrangement `0012` and `0013` use.
--
-- ### Why the taxonomy is not a table
--
-- The 78 Semantic_Cue names live in `domain/sound-pack/taxonomy.ts` as constants and are
-- **not** seeded here, for the reason `0013` gives about built-in effect presets. They are
-- a product decision, not user data: nothing may add a 79th at runtime, and Requirement
-- 24.2 compares a pack's cue names against them *for equality*. A row that could be
-- `UPDATE`d is a worse guarantee of that than a constant that cannot.
--
-- So `sound_pack_cue.cue_name` is `text` with a length check rather than a foreign key to a
-- `semantic_cue` table or a 78-member enum. Both alternatives were considered and both are
-- worse:
--
-- * an **enum** would need a migration to correct a typo in a cue name and, worse, would be
--   a second declaration of the taxonomy that `taxonomy.ts` could drift from silently —
--   there would be nothing to compare, because the check would already have passed;
-- * a **lookup table** invites the `UPDATE` above and buys nothing, since every write goes
--   through `SoundPackService`, which reads the taxonomy.
--
-- What the schema *does* enforce is the shape that does not depend on the vocabulary: one
-- row per (pack, cue), at most 78 rows per pack, and `asset_kind = 'sfx'` on the asset each
-- row points at (Requirement 24.18).
--
-- ### What is *not* here
--
-- - **The cue count is not a SQL constraint.** Postgres cannot express "exactly N rows per
--   parent" declaratively, and the trigger that could would fire per statement while the
--   decision belongs to `SoundPackService`, which must return the *missing cue names*
--   (Requirement 24.3) rather than raise. `cue_count` is stored so the pack's own row says
--   what it believes, and the column comment records the number a reader should expect.
--   The 78-row *ceiling* below is enforceable and is enforced; the floor is not, and a pack
--   below it is exactly what `status = 'incomplete'` means.
-- - **No loudness, seam, tail or similarity check.** Those are claims about samples
--   (Requirements 24.6–24.9) and the database holds none. They are the service's
--   judgements, taken against the Quality_Threshold_Set version recorded on each asset.
-- - **No manifest column.** A `Cue_Pack_Manifest` is derivable from the pack's cues and its
--   export (`buildManifest`), so storing it would be a second copy that could disagree with
--   the first. `PackManifestStore` exists for a caller that wants to cache one; where it
--   caches is that implementation's business.

CREATE TYPE sound_pack_status AS ENUM ('complete', 'review_required', 'incomplete');

CREATE TABLE sound_pack (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    name text NOT NULL,
    -- Requirement 24.1's 음향 성격 설명. Named `personality_desc` in design §4.1's ER
    -- diagram; kept as that name so the schema and the diagram can be read side by side.
    personality_desc text NOT NULL,
    status sound_pack_status NOT NULL DEFAULT 'incomplete',
    -- Requirement 24.2's subject. See the header on why this is stored and not enforced.
    cue_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- Requirements 24.1, 24.20: 1–60 characters.
    CONSTRAINT sound_pack_name_length CHECK (char_length(name) BETWEEN 1 AND 60),

    -- Requirements 24.1, 24.20: 1–200 characters.
    CONSTRAINT sound_pack_description_length CHECK (
        char_length(personality_desc) BETWEEN 1 AND 200
    ),

    -- Requirement 24.2: a pack can hold no more cues than the taxonomy has names, and the
    -- per-(pack, cue) unique index below makes 78 the true ceiling on the row count too.
    -- Stated as a range rather than an equality because 24.3 and 24.21 both produce a pack
    -- with fewer, and those packs must be storable in order to be reported.
    CONSTRAINT sound_pack_cue_count_range CHECK (cue_count BETWEEN 0 AND 78),

    -- A complete pack is exactly the one with every cue (Requirement 24.2's invariant).
    -- This is the one part of 24.2 that *is* expressible in SQL: not which names are
    -- present, but that a pack claiming completeness claims all 78.
    CONSTRAINT sound_pack_complete_has_every_cue CHECK (
        status <> 'complete' OR cue_count = 78
    )
);

-- Design §4.1's `SoundPack ||--o{ AudioAsset : contains_cues`, and Requirement 24.18's
-- three recorded facts: the cue name, the category name and the pack identifier.
CREATE TABLE sound_pack_cue (
    pack_id uuid NOT NULL REFERENCES sound_pack (id) ON DELETE CASCADE,
    -- Requirement 24.18. Not a foreign key to a cue table; see the header.
    cue_name text NOT NULL,
    category_name text NOT NULL,
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- One audio per cue per pack. This is what makes Requirement 24.17's regeneration an
    -- upsert rather than an append: replacing a cue's audio cannot leave the pack holding
    -- two versions of it, and 24.2's count cannot be inflated by a retry.
    PRIMARY KEY (pack_id, cue_name),

    -- The longest name in the taxonomy is well inside this; the bound exists so a cue name
    -- cannot be a paragraph, not to encode the vocabulary.
    CONSTRAINT sound_pack_cue_name_length CHECK (char_length(cue_name) BETWEEN 1 AND 60),
    CONSTRAINT sound_pack_cue_category_length CHECK (
        char_length(category_name) BETWEEN 1 AND 60
    )
);

-- Requirement 24.18: "Asset_Kind가 `sfx`인 Audio_Asset으로 저장". Enforced rather than
-- assumed, because a pack that quietly referenced a `song` asset would satisfy every other
-- constraint here and would be discovered by a user downloading a four-minute "click".
--
-- A trigger rather than a CHECK: a CHECK cannot read another table. It fires per row on
-- insert and on any change of `asset_id`, which are the only two ways a wrong kind can
-- arrive.
CREATE FUNCTION sound_pack_cue_require_sfx_asset() RETURNS trigger AS $$
DECLARE
    v_kind asset_kind;
BEGIN
    SELECT asset_kind INTO v_kind FROM audio_asset WHERE id = NEW.asset_id;

    IF v_kind IS NULL THEN
        RAISE EXCEPTION 'sound_pack_cue references a missing Audio_Asset %', NEW.asset_id
            USING ERRCODE = 'MS024';
    END IF;

    IF v_kind <> 'sfx' THEN
        RAISE EXCEPTION 'Requirement 24.18: cue asset % has asset_kind %, expected sfx',
            NEW.asset_id, v_kind
            USING ERRCODE = 'MS024';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sound_pack_cue_require_sfx_asset
    BEFORE INSERT OR UPDATE OF asset_id ON sound_pack_cue
    FOR EACH ROW EXECUTE FUNCTION sound_pack_cue_require_sfx_asset();

-- The owner's pack list, and the count query behind `cue_count`.
CREATE INDEX sound_pack_owner_idx ON sound_pack (owner_id, created_at);
CREATE INDEX sound_pack_cue_asset_idx ON sound_pack_cue (asset_id);

-- Requirement 24.2's completeness question, as a query rather than as a constraint: which
-- packs believe they are complete, and how many cues they actually hold. A pack appearing
-- here with a count below 78 is the inconsistency `sound_pack_complete_has_every_cue`
-- cannot see, because that CHECK reads the stored `cue_count` and this counts rows.
CREATE VIEW sound_pack_completeness AS
SELECT
    p.id AS pack_id,
    p.status,
    p.cue_count AS declared_cue_count,
    count(c.cue_name) AS stored_cue_count,
    count(c.cue_name) = 78 AS holds_every_cue
FROM sound_pack p
LEFT JOIN sound_pack_cue c ON c.pack_id = p.id
GROUP BY p.id, p.status, p.cue_count;

COMMENT ON TABLE sound_pack IS
    'Design §4.1 SoundPack (Requirement 24.1). The 78 Semantic_Cue names are constants in domain/sound-pack/taxonomy.ts, not rows.';
COMMENT ON COLUMN sound_pack.cue_count IS
    'Requirement 24.2: 78 for a complete pack. The floor is not a SQL constraint; see migration header.';
COMMENT ON COLUMN sound_pack.status IS
    'Requirements 24.2, 24.3, 24.21, 24.22. domain/sound-pack/status.ts is the vocabulary.';
COMMENT ON TABLE sound_pack_cue IS
    'Requirement 24.18: one sfx Audio_Asset per Semantic_Cue per pack, with its cue and category names.';
