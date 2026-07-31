-- 0015 — Timeline_Project, Timeline_Clip and per-track settings (Requirements 28.1–28.18, 28.39).
--
-- Design §4.1's `TimelineProject` entity and the `holds_clips` relationship it draws to
-- `AudioAsset`. A thin wrapper over the rules stated in `domain/timeline/`, with the same
-- numbers on both sides:
--
--   track range (0–31)             domain/timeline/bounds.ts   TRACK_INDEX_MIN/MAX
--   track count (32)               domain/timeline/bounds.ts   TRACK_COUNT
--   clip ceiling (500)             domain/timeline/bounds.ts   PROJECT_CLIP_COUNT_MAX
--   clip gain (-40…+12 dB)         domain/timeline/bounds.ts   CLIP_GAIN_DB_MIN/MAX
--   track volume (-60…+12 dB)      domain/timeline/bounds.ts   TRACK_VOLUME_DB_MIN/MAX
--   track pan (-1…+1)              domain/timeline/bounds.ts   TRACK_PAN_MIN/MAX
--   fade ceiling (50 % of play)    domain/timeline/bounds.ts   FADE_MAX_PLAY_LENGTH_RATIO
--   tempo (30–300 BPM)             domain/timeline/bounds.ts   TEMPO_BPM_MIN/MAX
--   time signature (2/3/4/6)       domain/timeline/bounds.ts   TIME_SIGNATURES
--   name/description lengths       domain/timeline/bounds.ts   PROJECT_NAME_*/DESCRIPTION_*
--
-- `test/unit/timeline/schema-parity.test.ts` fails if the two sides drift, and it needs no
-- database — the same arrangement 0012, 0013 and 0014 use, and the only one available here.
--
-- ### What is enforced declaratively, and what needs a trigger
--
-- Most of Requirement 28 is a per-row range and is a CHECK. Three rules are not:
--
-- * **Requirement 28.13's play length** depends on the referenced asset's duration. The column
--   `source_duration_ms` mirrors `audio_asset.duration_ms` so that `play_length_ms` can be a
--   generated column and so that the trim invariants of 28.10 and 28.11 become CHECKs. The
--   mirror is *verified*, not trusted: `timeline_clip_bounds` refuses a row whose copy disagrees
--   with the asset. The same denormalisation, for the same reason, as
--   `domain/timeline/project.ts` — it is what makes 28.10, 28.11 and 28.13 decidable from the
--   clip alone.
-- * **Requirement 28.5's ceiling of 500** is "at most N rows per parent", which Postgres cannot
--   express declaratively. A trigger counts. Unlike 0014's cue count there is no floor to worry
--   about: an empty project is exactly what Requirement 28.1 creates.
-- * **Requirement 28.7's non-overlap** is a statement about pairs of rows. It could be an
--   `EXCLUDE USING gist` constraint over an `int4range`, which would be the better tool — and it
--   is deliberately not used, because it requires the `btree_gist` contrib module and this schema
--   installs no extensions. A trigger with an explicit range test needs nothing extra and reports
--   the overlap length, which Requirement 28.8 asks for and an exclusion constraint cannot.
--
-- ### What is *not* here
--
-- * **No undo history.** Requirement 28.22 keeps the last 100 operations, and Requirement 28.32
--   excludes them from the project equivalence relation. They are session-lifetime editing state,
--   not a record of anything: a command holds captured before/after values that are only
--   meaningful against the exact project state they were planned on, so persisting them across a
--   schema change would resurrect an inverse that no longer inverts anything. `TimelineProjectStore`
--   holds them beside the project; where that implementation puts them is its business.
-- * **No mixdown column.** Requirement 28.24 stores the result as an `Asset_Kind = 'mix'`
--   `Audio_Asset`, which 0003 already models, and the lineage back to the project's clips is
--   0005's. A column here would be a second copy that could disagree with both. Task 4.2's.
-- * **No snap setting.** Requirement 28.21's snapping is a per-request flag (`WHERE 스냅 기능이
--   활성화된 경우`), not stored project state, so storing it would invent a persistence the
--   requirement does not describe.

CREATE TABLE timeline_project (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    -- Requirement 28.1: a name and a description.
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- Requirement 28.39: both NULL-able, and independently so — 28.21's last clause and 28.39
    -- both legislate for a project with no tempo, in which case no bar boundary is offered.
    tempo_bpm integer,
    time_signature smallint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- Derived, not quoted: Requirement 28.1 states no length. See domain/timeline/bounds.ts.
    CONSTRAINT timeline_project_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT timeline_project_description_length CHECK (char_length(description) BETWEEN 0 AND 2000),
    -- Requirement 28.39.
    CONSTRAINT timeline_project_tempo_range CHECK (tempo_bpm IS NULL OR tempo_bpm BETWEEN 30 AND 300),
    CONSTRAINT timeline_project_time_signature CHECK (
        time_signature IS NULL OR time_signature IN (2, 3, 4, 6)
    )
);

COMMENT ON COLUMN timeline_project.tempo_bpm IS
    'Requirement 28.39: 30–300 integer BPM, or NULL. NULL means Requirement 28.21 offers no bar-boundary snap candidate.';

CREATE INDEX timeline_project_owner_idx ON timeline_project (owner_id, created_at DESC);

CREATE TABLE timeline_clip (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES timeline_project (id) ON DELETE CASCADE,
    -- Requirement 28.36: the asset may be marked deleted while a clip still points at it, so the
    -- reference is RESTRICT-free and the *soft* delete flag on audio_asset is what signals it.
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE RESTRICT,

    -- Requirement 28.32 makes 클립 목록의 순서 part of the project equivalence relation, so the
    -- order is stored rather than left to whatever order a SELECT happens to return.
    position integer NOT NULL,

    -- Mirrors audio_asset.duration_ms; verified by timeline_clip_bounds. See the header.
    source_duration_ms integer NOT NULL,

    -- Requirement 28.3: every time value is an integer count of milliseconds.
    start_time_ms integer NOT NULL,
    -- Requirement 28.4.
    track smallint NOT NULL,
    trim_start_ms integer NOT NULL DEFAULT 0,
    trim_end_ms integer NOT NULL DEFAULT 0,
    -- Requirement 28.16. numeric(4,1) matches the 0.1 dB comparison tolerance of 28.32: a value
    -- the database cannot represent is a value the equivalence relation could not have accepted.
    gain_db numeric(4, 1) NOT NULL DEFAULT 0,
    fade_in_ms integer NOT NULL DEFAULT 0,
    fade_out_ms integer NOT NULL DEFAULT 0,
    muted boolean NOT NULL DEFAULT false,

    -- Requirement 28.13, as a generated column so nothing can store a play length that disagrees
    -- with the three numbers it is defined from.
    play_length_ms integer GENERATED ALWAYS AS (source_duration_ms - trim_start_ms - trim_end_ms) STORED,

    CONSTRAINT timeline_clip_position_range CHECK (position >= 0),
    CONSTRAINT timeline_clip_source_duration_range CHECK (source_duration_ms BETWEEN 1 AND 3600000),
    CONSTRAINT timeline_clip_start_time_range CHECK (start_time_ms >= 0),
    -- Requirement 28.4: 0–31.
    CONSTRAINT timeline_clip_track_range CHECK (track BETWEEN 0 AND 31),
    -- Requirement 28.10's first half.
    CONSTRAINT timeline_clip_trim_non_negative CHECK (trim_start_ms >= 0 AND trim_end_ms >= 0),
    -- Requirement 28.10's second half, stated by the clause as a strict inequality: the trims sum
    -- to *less than* the source length, so at least 1 ms remains.
    CONSTRAINT timeline_clip_trim_within_source CHECK (
        trim_start_ms + trim_end_ms < source_duration_ms
    ),
    -- Requirement 28.16: -40…+12 dB.
    CONSTRAINT timeline_clip_gain_range CHECK (gain_db BETWEEN -40 AND 12),
    -- Requirement 28.17: each fade is 0…50 % of the play length. Written against the generated
    -- column, and doubled instead of halved so the comparison stays in integers.
    CONSTRAINT timeline_clip_fade_range CHECK (
        fade_in_ms >= 0
        AND fade_out_ms >= 0
        AND fade_in_ms * 2 <= source_duration_ms - trim_start_ms - trim_end_ms
        AND fade_out_ms * 2 <= source_duration_ms - trim_start_ms - trim_end_ms
    ),

    -- One clip per position, so the order of Requirement 28.32 is total and unambiguous.
    CONSTRAINT timeline_clip_position_unique UNIQUE (project_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX timeline_clip_project_idx ON timeline_clip (project_id, position);
CREATE INDEX timeline_clip_asset_idx ON timeline_clip (asset_id);
-- The lookup the overlap trigger makes.
CREATE INDEX timeline_clip_track_idx ON timeline_clip (project_id, track, start_time_ms);

CREATE TABLE timeline_track (
    project_id uuid NOT NULL REFERENCES timeline_project (id) ON DELETE CASCADE,
    -- Requirement 28.4: 0–31. Every project has all 32 rows; see the header of
    -- domain/timeline/project.ts on why the set is dense rather than sparse.
    track smallint NOT NULL,
    -- Requirement 28.18. numeric precisions match Requirement 28.32's tolerances, as above.
    volume_db numeric(4, 1) NOT NULL DEFAULT 0,
    pan numeric(3, 2) NOT NULL DEFAULT 0,
    muted boolean NOT NULL DEFAULT false,
    solo boolean NOT NULL DEFAULT false,

    PRIMARY KEY (project_id, track),

    CONSTRAINT timeline_track_range CHECK (track BETWEEN 0 AND 31),
    -- Requirement 28.18: -60…+12 dB, and -1.0…+1.0.
    CONSTRAINT timeline_track_volume_range CHECK (volume_db BETWEEN -60 AND 12),
    CONSTRAINT timeline_track_pan_range CHECK (pan BETWEEN -1.0 AND 1.0)
);

-- Requirements 28.5, 28.7, 28.8 and the source-duration mirror. The three rules a CHECK cannot
-- express, in one trigger so a clip write is validated once rather than three times.
CREATE FUNCTION timeline_clip_bounds() RETURNS trigger AS $$
DECLARE
    v_asset_duration integer;
    v_clip_count integer;
    v_conflict record;
BEGIN
    SELECT duration_ms INTO v_asset_duration FROM audio_asset WHERE id = NEW.asset_id;
    IF v_asset_duration IS NULL THEN
        RAISE EXCEPTION 'Timeline_Clip references a missing Audio_Asset %', NEW.asset_id
            USING ERRCODE = 'MS028';
    END IF;

    -- The mirror is verified, not trusted (Requirement 28.13).
    IF NEW.source_duration_ms <> v_asset_duration THEN
        RAISE EXCEPTION 'Timeline_Clip source_duration_ms % disagrees with asset duration %',
            NEW.source_duration_ms, v_asset_duration
            USING ERRCODE = 'MS028';
    END IF;

    -- Requirement 28.5: at most 500 clips per project; the 501st is refused.
    IF TG_OP = 'INSERT' THEN
        SELECT count(*) INTO v_clip_count FROM timeline_clip WHERE project_id = NEW.project_id;
        IF v_clip_count >= 500 THEN
            RAISE EXCEPTION 'Timeline_Project % already holds % of 500 clips',
                NEW.project_id, v_clip_count
                USING ERRCODE = 'MS028';
        END IF;
    END IF;

    -- Requirements 28.7, 28.8: half-open intervals, so clips that merely touch do not collide.
    SELECT id,
           least(
               start_time_ms + play_length_ms,
               NEW.start_time_ms + (NEW.source_duration_ms - NEW.trim_start_ms - NEW.trim_end_ms)
           ) - greatest(start_time_ms, NEW.start_time_ms) AS overlap_ms
      INTO v_conflict
      FROM timeline_clip
     WHERE project_id = NEW.project_id
       AND track = NEW.track
       AND id <> NEW.id
       AND start_time_ms
             < NEW.start_time_ms + (NEW.source_duration_ms - NEW.trim_start_ms - NEW.trim_end_ms)
       AND start_time_ms + play_length_ms > NEW.start_time_ms
     LIMIT 1;

    IF v_conflict.id IS NOT NULL THEN
        RAISE EXCEPTION 'Timeline_Clip % overlaps clip % on track % by % ms',
            NEW.id, v_conflict.id, NEW.track, v_conflict.overlap_ms
            USING ERRCODE = 'MS028';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER timeline_clip_bounds
    BEFORE INSERT OR UPDATE ON timeline_clip
    FOR EACH ROW EXECUTE FUNCTION timeline_clip_bounds();

-- Every project has all 32 tracks (Requirement 28.4), so they are created with it rather than
-- lazily on first use — a lazily-created row makes "각 트랙의 음량" of Requirement 28.32 depend on
-- whether anyone happened to touch the track.
CREATE FUNCTION timeline_project_seed_tracks() RETURNS trigger AS $$
BEGIN
    INSERT INTO timeline_track (project_id, track)
    SELECT NEW.id, generate_series(0, 31);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER timeline_project_seed_tracks
    AFTER INSERT ON timeline_project
    FOR EACH ROW EXECUTE FUNCTION timeline_project_seed_tracks();

-- Requirement 28.36's read: which clips of a project point at an asset marked deleted.
CREATE VIEW timeline_clip_availability AS
SELECT c.project_id,
       c.id AS clip_id,
       c.asset_id,
       a.is_deleted AS asset_deleted
  FROM timeline_clip c
  JOIN audio_asset a ON a.id = c.asset_id;
