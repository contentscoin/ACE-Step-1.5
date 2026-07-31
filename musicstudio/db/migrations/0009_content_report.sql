-- 0009 — content reports and Audio_Asset review state (Requirements 16.8, 16.9).
--
-- Thin wrapper over the rules stated in `domain/moderation/review-state.ts`. Same
-- four states, same transition table, same discovery-feed predicate:
--
--   states                 none | under_review | cleared | withheld
--   report transition      asset_review_state_after_report()
--   resolution transition  asset_review_state_after_resolution()
--   feed predicate         asset_review_state_excluded_from_feed()
--                          -> view audio_asset_discoverable
--
-- `test/unit/schema-parity.test.ts` fails if the two sides drift apart, and it
-- needs no database.
--
-- Errors use SQLSTATE MS016 (Requirement 16), alongside the existing MS018/MS019/
-- MS033 classes declared in 0001_enums.sql.

CREATE TYPE asset_review_state AS ENUM (
    'none',
    'under_review',
    'cleared',
    'withheld'
);

COMMENT ON TYPE asset_review_state IS
    'Requirements 16.8, 16.9: review state of a public Audio_Asset. Mirrors domain/moderation/review-state.ts.';

CREATE TYPE report_reason AS ENUM (
    'policy_violation',
    'rights_infringement',
    'impersonation',
    'other'
);

-- Requirement 16.8: the asset is *marked* under review; the mark lives on the asset
-- because Requirement 16.9's feed query filters assets, not reports.
ALTER TABLE audio_asset
    ADD COLUMN review_state asset_review_state NOT NULL DEFAULT 'none';

COMMENT ON COLUMN audio_asset.review_state IS
    'Requirement 16.8/16.9: set by report intake; under_review and withheld are excluded from the discovery feed.';

CREATE TABLE content_report (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    -- NULL for an unauthenticated visitor; Requirement 16.8 says 방문자, not 사용자.
    reporter_account_id uuid REFERENCES account (id) ON DELETE SET NULL,
    reason report_reason NOT NULL,
    detail text,
    submitted_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT content_report_detail_length CHECK (
        detail IS NULL OR char_length(detail) BETWEEN 1 AND 1000
    )
);

COMMENT ON TABLE content_report IS
    'Requirement 16.8: accepted reports against public Audio_Assets. Not deduplicated — the count is operator signal.';

CREATE INDEX content_report_asset_idx ON content_report (asset_id, submitted_at DESC);

-- Requirement 16.8 — same total, idempotent function as the domain module: a second
-- report leaves an asset under review, and a report never resurrects a withheld
-- asset into the queue.
CREATE OR REPLACE FUNCTION asset_review_state_after_report(p_current asset_review_state)
RETURNS asset_review_state
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_current = 'withheld' THEN 'withheld'::asset_review_state
                ELSE 'under_review'::asset_review_state END;
$$;

-- Only an asset under review has a review to close.
CREATE OR REPLACE FUNCTION asset_review_state_after_resolution(
    p_current asset_review_state,
    p_resolution asset_review_state
)
RETURNS asset_review_state
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF p_resolution NOT IN ('cleared', 'withheld') THEN
        RAISE EXCEPTION 'review resolution must be cleared or withheld, received %', p_resolution
            USING ERRCODE = 'MS016';
    END IF;

    RETURN CASE WHEN p_current = 'under_review' THEN p_resolution ELSE p_current END;
END;
$$;

-- Requirement 16.9 — the discovery-feed predicate.
CREATE OR REPLACE FUNCTION asset_review_state_excluded_from_feed(p_state asset_review_state)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_state IN ('under_review', 'withheld');
$$;

-- Requirement 16.8: accepting a report marks the asset. Kept in SQL so a report
-- inserted by any path — API, operator tool, backfill — carries the same effect.
CREATE OR REPLACE FUNCTION content_report_mark_under_review()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE audio_asset
       SET review_state = asset_review_state_after_report(review_state)
     WHERE id = NEW.asset_id
       AND review_state <> asset_review_state_after_report(review_state);
    RETURN NULL;
END;
$$;

CREATE TRIGGER content_report_mark_under_review_after_insert
    AFTER INSERT ON content_report
    FOR EACH ROW
    EXECUTE FUNCTION content_report_mark_under_review();

-- A review may only close from under_review, and only to cleared or withheld.
CREATE OR REPLACE FUNCTION audio_asset_guard_review_transition()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.review_state = OLD.review_state THEN
        RETURN NEW;
    END IF;

    IF NEW.review_state = 'under_review' THEN
        -- Entering review is always legal except out of withheld, which the report
        -- transition already refuses.
        IF OLD.review_state = 'withheld' THEN
            RAISE EXCEPTION
                'a withheld asset cannot re-enter review (Requirement 16.8)'
                USING ERRCODE = 'MS016';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.review_state <> 'under_review' THEN
        RAISE EXCEPTION
            'review state may only move to % from under_review, not from % (Requirement 16.8)',
            NEW.review_state, OLD.review_state
            USING ERRCODE = 'MS016';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER audio_asset_review_transition
    BEFORE UPDATE OF review_state ON audio_asset
    FOR EACH ROW
    EXECUTE FUNCTION audio_asset_guard_review_transition();

-- Requirement 16.9: what task 5.3's discovery feed selects from, so the exclusion is
-- applied by construction rather than by every caller remembering the predicate.
-- Publication and soft-delete remain 5.3's own conditions; only `is_deleted` is
-- folded in here because a deleted asset is never discoverable under any rule.
CREATE VIEW audio_asset_discoverable AS
SELECT *
FROM audio_asset
WHERE NOT is_deleted
  AND NOT asset_review_state_excluded_from_feed(review_state);

COMMENT ON VIEW audio_asset_discoverable IS
    'Requirement 16.9: assets not excluded by review state. Task 5.3 ANDs publication onto this.';

CREATE INDEX audio_asset_review_state_idx
    ON audio_asset (review_state)
    WHERE review_state <> 'none';
