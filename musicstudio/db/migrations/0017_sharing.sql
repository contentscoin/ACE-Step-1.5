-- 0017 — publication, discovery, likes and personas (Requirements 14, 15).
--
-- Bounds and vocabularies mirror `domain/sharing/` and `domain/persona/`, and
-- `test/unit/sharing/schema-parity.test.ts` fails if the two drift:
--
--   share token length (43)        domain/sharing/bounds.ts             SHARE_TOKEN_LENGTH
--   genre bound (1–40), cap (10)   domain/sharing/bounds.ts             ASSET_GENRE_*
--   persona name bound (1–60)      domain/persona/training-request.ts   PERSONA_NAME_*_LENGTH
--   reference floor (8) / cap(100) domain/persona/training-request.ts   PERSONA_REFERENCE_*
--   persona status vocabulary      domain/persona/persona.ts            PERSONA_STATUSES
--
-- ### Why publication is a row and not a column
--
-- `audio_asset.is_public boolean` would be the smaller change. It is the wrong one, because
-- Requirement 14.2 issues a link and Requirement 14.4 destroys it, and those are facts about
-- a *publication* rather than about the asset: the token, when it was issued, and whether
-- remixing was permitted (14.9) all belong to the act of publishing. A row that exists while
-- the asset is public says all of it, and revoking is a DELETE — which is also what makes
-- 14.4's 404 total. A column would leave the token behind to be reused.
--
-- Republishing therefore mints a **new** token. That is deliberate: a link the owner revoked
-- must not come back to life because they published again later.

CREATE TABLE asset_share (
    -- One publication per asset, so the primary key is the asset. There is no history table:
    -- Requirement 14.2 records the change in the Audit_Log, which is the append-only record
    -- that already exists for exactly this (`0008_audit_log.sql`, event `visibility_changed`).
    asset_id uuid PRIMARY KEY REFERENCES audio_asset (id) ON DELETE CASCADE,

    -- Requirement 14.2's "추측이 어려운 공개 링크". 32 random bytes, base64url — 43 chars.
    -- UNIQUE because the token is looked up on its own: a visitor arrives with nothing else.
    share_token text NOT NULL UNIQUE,

    published_at timestamptz NOT NULL DEFAULT now(),
    -- Requirement 14.9. Default false: publishing grants viewing, never derivation.
    remix_allowed boolean NOT NULL DEFAULT false,

    CONSTRAINT asset_share_token_length CHECK (char_length(share_token) = 43),
    -- base64url alphabet. A token with a `+`, `/` or `=` in it did not come from this
    -- service, and a padded or percent-escaped token would not survive a URL round trip.
    CONSTRAINT asset_share_token_alphabet CHECK (share_token ~ '^[A-Za-z0-9_-]+$')
);

-- Requirement 14.5's feed reads publications newest first.
CREATE INDEX asset_share_published_at_idx ON asset_share (published_at DESC, asset_id);

-- Requirement 14.11: a Sound_Pack is published as **one** item, not as 78.
--
-- Its own table rather than a nullable column on `asset_share`, because a pack publication
-- is not an asset publication: the 78 cues stay private as individual assets and the pack is
-- what the feed shows. Sharing_Service reads both tables and merges; nothing here has to
-- decide what a cue's own publication would mean, because a cue never gets one.
CREATE TABLE sound_pack_share (
    sound_pack_id uuid PRIMARY KEY REFERENCES sound_pack (id) ON DELETE CASCADE,
    share_token text NOT NULL UNIQUE,
    published_at timestamptz NOT NULL DEFAULT now(),
    remix_allowed boolean NOT NULL DEFAULT false,

    CONSTRAINT sound_pack_share_token_length CHECK (char_length(share_token) = 43),
    CONSTRAINT sound_pack_share_token_alphabet CHECK (share_token ~ '^[A-Za-z0-9_-]+$')
);

-- Requirements 14.7, 14.8 — **Property 20**.
--
-- The idempotence is the primary key. Not a check before the insert, not a count compared
-- in the service: the pair *is* the identity of a like, so a second insert is a conflict the
-- database refuses. That matters precisely in the case the criterion is about — a
-- double-tapped button sends two requests, and two application servers each holding a count
-- they read a moment ago would otherwise both insert.
CREATE TABLE asset_like (
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    liked_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (asset_id, account_id)
);

-- Requirement 14.5's like-count ordering, and a user's own "did I like this" lookup.
CREATE INDEX asset_like_account_idx ON asset_like (account_id, liked_at DESC);

-- Requirement 14.6's 장르.
--
-- A table, exactly like `asset_tag` in 0016 and for the same reasons: a genre is a row that
-- can be indexed and constrained, and the filter is a membership test. Stored normalised, so
-- the feed filter does not case-fold at read time.
--
-- Genres are engine-reported (Requirement 3.4) rather than user-authored, which is the only
-- difference from tags — and the reason for a separate table rather than a `kind` column on
-- `asset_tag`: Requirement 11.3 searches *tags* and would otherwise start matching genres.
CREATE TABLE asset_genre (
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    genre text NOT NULL,

    PRIMARY KEY (asset_id, genre),

    CONSTRAINT asset_genre_length CHECK (char_length(genre) BETWEEN 1 AND 40),
    CONSTRAINT asset_genre_normalised CHECK (genre = lower(btrim(genre)))
);

CREATE INDEX asset_genre_genre_idx ON asset_genre (genre);

CREATE OR REPLACE FUNCTION asset_genre_count_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM asset_genre WHERE asset_id = NEW.asset_id;
    IF v_count > 10 THEN
        RAISE EXCEPTION 'asset_genre limit exceeded: % has % genres, ceiling is 10',
            NEW.asset_id, v_count;
    END IF;
    RETURN NULL;
END;
$$;

-- Same shape as `asset_tag_count_guard_after_insert`: a CHECK cannot see sibling rows.
CREATE CONSTRAINT TRIGGER asset_genre_count_guard_after_insert
    AFTER INSERT ON asset_genre
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW
    EXECUTE FUNCTION asset_genre_count_guard();

-- Requirement 15 — Persona.
CREATE TYPE persona_status AS ENUM ('queued', 'training', 'ready', 'failed', 'deleted');

CREATE TABLE persona (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Requirements 15.4, 15.6: "요청자 전용". RESTRICT rather than CASCADE, matching
    -- `audio_asset.owner_id`: an account with trained adapters is not silently erasable.
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
    name text NOT NULL,
    status persona_status NOT NULL DEFAULT 'queued',

    -- The engine's handles, opaque to this layer (design §1.4.4).
    training_job_id text,
    adapter_ref text,

    -- Requirement 15.8's consent record: the requester confirmed they hold the rights to
    -- every reference song. Stored on the persona rather than per track because the
    -- confirmation is one act over one set, and a per-row copy could disagree with itself.
    rights_confirmed_at timestamptz NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT persona_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
    -- Requirement 15.4: a ready persona is one with an adapter. The state and the artefact
    -- cannot disagree, which is what makes 15.5's selectability a property of the row.
    CONSTRAINT persona_ready_has_adapter CHECK (status <> 'ready' OR adapter_ref IS NOT NULL),
    -- Requirement 15.7: deletion removes the adapter. A deleted persona holding a ref would
    -- be an adapter still loadable by anything that read the column.
    CONSTRAINT persona_deleted_has_no_adapter CHECK (status <> 'deleted' OR adapter_ref IS NULL)
);

CREATE INDEX persona_owner_idx ON persona (owner_id, created_at DESC);
-- The single-tenant engine (see `domain/persona/persona.ts`) has at most one live run; this
-- is what the queue reads to find who is next.
CREATE INDEX persona_status_idx ON persona (status, created_at) WHERE status IN ('queued', 'training');

-- Requirement 15.1's 참조 곡 8개 이상.
CREATE TABLE persona_reference_track (
    persona_id uuid NOT NULL REFERENCES persona (id) ON DELETE CASCADE,
    -- RESTRICT: a reference song is evidence for the consent record above, and an asset row
    -- vanishing under it would leave the persona unable to say what it was trained on.
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE RESTRICT,
    position integer NOT NULL,

    -- One row per (persona, asset): eight copies of one song is one song, which is the same
    -- rule `distinctReferences` applies before the floor of 8 is counted.
    PRIMARY KEY (persona_id, asset_id),
    CONSTRAINT persona_reference_track_position_range CHECK (position BETWEEN 0 AND 99)
);

-- The floor of 8 is *not* a SQL constraint, for the reason 0014 gives about the 78-cue
-- floor: Postgres cannot express "at least N rows per parent" declaratively, and the check
-- belongs to Persona_Service anyway — Requirement 15.2 requires the minimum to be *returned*
-- to the caller, which a raised exception cannot do. The ceiling is expressible, and is the
-- `position` range above.
