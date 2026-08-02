-- 0016 — the columns and tables Library_Service needs (Requirements 11.3, 11.4, 11.10).
--
-- Task 1.1 stored an `Audio_Asset`'s identity, shape and provenance. Three things the
-- glossary lists as part of the asset were not stored, because nothing until now read
-- them, and Requirement 11 reads all three:
--
--   11.3  search covers 제목, 캡션, 가사, 태그  ->  caption, lyrics, asset_tag
--   11.4  sort by 재생 횟수                    ->  play_count
--   11.10 a playlist preserving user order      ->  playlist, playlist_item
--
-- Bounds mirror `domain/library/`, and `test/unit/library/schema-parity.test.ts` fails if
-- the two drift:
--
--   caption bound (0–2000)      domain/library/bounds.ts   ASSET_CAPTION_MAX_LENGTH
--   tag bound (1–30)            domain/library/bounds.ts   ASSET_TAG_*_LENGTH
--   tags per asset (20)         domain/library/bounds.ts   ASSET_TAG_COUNT_MAX
--   playlist name bound (1–200) domain/library/bounds.ts   PLAYLIST_NAME_*_LENGTH
--
-- Lyrics carry no length check on purpose. Requirement 4.1 requires the *entire* lyric
-- text to reach the engine "never truncated", and a column that refused a long lyric
-- would make an asset unstorable for a reason no requirement states.

ALTER TABLE audio_asset
    ADD COLUMN caption text NOT NULL DEFAULT '',
    ADD COLUMN lyrics text NOT NULL DEFAULT '',
    -- Requirement 11.4's sort key and Requirement 12.4's counter. Non-negative rather than
    -- unconstrained: a negative play count would sort above every real asset.
    ADD COLUMN play_count bigint NOT NULL DEFAULT 0;

ALTER TABLE audio_asset
    ADD CONSTRAINT audio_asset_caption_length CHECK (char_length(caption) <= 2000),
    ADD CONSTRAINT audio_asset_play_count_non_negative CHECK (play_count >= 0);

-- Requirement 11.4's three sort orders, each over Requirement 11.1's owner scope and
-- Requirement 11.7's deletion filter. Created as partial indexes on `NOT is_deleted` for
-- the same reason `audio_asset_kind_idx` is: a deleted asset is never listed, so it does
-- not belong in the index a listing reads.
CREATE INDEX audio_asset_owner_name_idx
    ON audio_asset (owner_id, lower(name), id)
    WHERE NOT is_deleted;

CREATE INDEX audio_asset_owner_play_count_idx
    ON audio_asset (owner_id, play_count DESC, id)
    WHERE NOT is_deleted;

-- Requirement 11.8's purge sweep reads exactly this: assets marked deleted, oldest first.
CREATE INDEX audio_asset_deleted_at_idx
    ON audio_asset (deleted_at)
    WHERE is_deleted;

-- Requirement 11.3's 태그.
--
-- A table rather than a `text[]` column so a tag is a row that can be indexed, counted and
-- constrained. The count ceiling needs a trigger — a CHECK cannot see sibling rows — and
-- that is the same reason `0006_lineage_invariants.sql` reaches for one.
CREATE TABLE asset_tag (
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    tag text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- One row per tag per asset: tagging twice is the same tag, not two.
    PRIMARY KEY (asset_id, tag),

    CONSTRAINT asset_tag_length CHECK (char_length(tag) BETWEEN 1 AND 30),
    -- Stored already normalised (see `domain/library/tags.ts`), so a search does not have
    -- to case-fold and two spellings of one tag cannot both exist.
    CONSTRAINT asset_tag_normalised CHECK (tag = lower(btrim(tag)))
);

CREATE INDEX asset_tag_tag_idx ON asset_tag (tag);

CREATE OR REPLACE FUNCTION asset_tag_count_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM asset_tag WHERE asset_id = NEW.asset_id;
    IF v_count > 20 THEN
        RAISE EXCEPTION 'asset_tag limit exceeded: % has % tags, ceiling is 20',
            NEW.asset_id, v_count;
    END IF;
    RETURN NULL;
END;
$$;

-- AFTER, and per statement's worth of rows, so a multi-row insert is judged on the total
-- it produces rather than on each row as it lands.
CREATE CONSTRAINT TRIGGER asset_tag_count_guard_after_insert
    AFTER INSERT ON asset_tag
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW
    EXECUTE FUNCTION asset_tag_count_guard();

-- Requirement 11.10: "사용자가 지정한 순서를 보존한 플레이리스트".
CREATE TABLE playlist (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT playlist_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE INDEX playlist_owner_idx ON playlist (owner_id, created_at DESC);

CREATE TABLE playlist_item (
    playlist_id uuid NOT NULL REFERENCES playlist (id) ON DELETE CASCADE,
    -- Requirement 11.10 stores an order, not a copy: the asset stays the library's.
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    position integer NOT NULL,

    -- The order *is* the primary key, which is what makes 11.10's "순서를 보존한" a
    -- property of the table rather than of the query that reads it.
    PRIMARY KEY (playlist_id, position),
    -- An asset appears at most once in a playlist, so a reorder cannot silently duplicate.
    CONSTRAINT playlist_item_unique_asset UNIQUE (playlist_id, asset_id),
    CONSTRAINT playlist_item_position_non_negative CHECK (position >= 0)
);
