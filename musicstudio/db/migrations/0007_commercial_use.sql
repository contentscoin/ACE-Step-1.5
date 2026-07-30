-- 0007 — Commercial-use propagation (design §4.3; Requirements 33.7, 33.20–33.22).
--
-- Design §4.3 prescribes write-time enforcement of a denormalised flag plus a
-- verification query. Both live here, and both mirror `domain/commercial-use.ts`.
--
-- Write time: a new lineage edge narrows the child (and everything below it) to
-- false when the input asset is not permitted. Because each parent's stored flag
-- already folds in its own ancestors, looking at direct parents is enough to get
-- the "every ancestor within depth 32" property by induction.
--
-- The flag only ever moves true -> false. Re-permitting requires a new asset from
-- a new job (Requirement 33.24), never an update in place (Requirement 33.17).

CREATE OR REPLACE FUNCTION audio_asset_reject_commercial_use_widening()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'commercial_use_allowed is monotonically non-increasing (Requirement 33.21)'
        USING ERRCODE = 'MS033',
              DETAIL = json_build_object('assetId', NEW.id)::text,
              HINT = 'regenerate with a commercially licensed engine instead (Requirement 33.24)';
END;
$$;

CREATE TRIGGER audio_asset_no_commercial_use_widening
    BEFORE UPDATE OF commercial_use_allowed ON audio_asset
    FOR EACH ROW
    WHEN (NOT OLD.commercial_use_allowed AND NEW.commercial_use_allowed)
    EXECUTE FUNCTION audio_asset_reject_commercial_use_widening();

-- Requirement 33.7: provenance is written once and preserved unchanged.
CREATE OR REPLACE FUNCTION audio_asset_reject_provenance_rewrite()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'provenance is immutable once recorded (Requirement 33.7)'
        USING ERRCODE = 'MS033', DETAIL = json_build_object('assetId', NEW.id)::text;
END;
$$;

CREATE TRIGGER audio_asset_no_provenance_rewrite
    BEFORE UPDATE OF provenance ON audio_asset
    FOR EACH ROW
    WHEN (OLD.provenance <> NEW.provenance)
    EXECUTE FUNCTION audio_asset_reject_provenance_rewrite();

-- Write-time propagation (Requirement 33.20).
CREATE OR REPLACE FUNCTION lineage_propagate_commercial_use()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_parent_allowed boolean;
BEGIN
    SELECT commercial_use_allowed INTO v_parent_allowed
    FROM audio_asset
    WHERE id = NEW.parent_asset_id;

    IF v_parent_allowed THEN
        RETURN NULL;
    END IF;

    UPDATE audio_asset a
       SET commercial_use_allowed = false
     WHERE a.commercial_use_allowed
       AND a.id IN (
               WITH RECURSIVE down (asset_id, depth) AS (
                   SELECT NEW.child_asset_id, 0
                   UNION
                   SELECT l.child_asset_id, down.depth + 1
                   FROM down
                   JOIN lineage l ON l.parent_asset_id = down.asset_id
                   WHERE down.depth < 32
               )
               SELECT asset_id FROM down
           );

    RETURN NULL;
END;
$$;

CREATE TRIGGER lineage_propagate_commercial_use_after_insert
    AFTER INSERT ON lineage
    FOR EACH ROW
    EXECUTE FUNCTION lineage_propagate_commercial_use();

-- Verification query (design §4.3): every asset marked permitted that has a
-- non-permitted ancestor within depth 32. Requirement 33.21 holds exactly when
-- this view is empty.
CREATE VIEW audio_asset_commercial_use_violation AS
WITH RECURSIVE ancestor_of (asset_id, ancestor_id, depth) AS (
    SELECT l.child_asset_id, l.parent_asset_id, 1
    FROM lineage l
    UNION ALL
    SELECT a.asset_id, l.parent_asset_id, a.depth + 1
    FROM ancestor_of a
    JOIN lineage l ON l.child_asset_id = a.ancestor_id
    WHERE a.depth < 32
)
SELECT
    child.id AS asset_id,
    array_agg(DISTINCT ancestor.id) AS offending_ancestor_ids
FROM ancestor_of a
JOIN audio_asset child ON child.id = a.asset_id
JOIN audio_asset ancestor ON ancestor.id = a.ancestor_id
WHERE child.commercial_use_allowed
  AND NOT ancestor.commercial_use_allowed
GROUP BY child.id;

COMMENT ON VIEW audio_asset_commercial_use_violation IS
    'Design §4.3 verification query. Requirement 33.21 holds iff this view returns no rows.';

-- Companion check for Requirement 19.7, so the lineage invariants are auditable
-- without re-deriving the graph in application code.
CREATE VIEW audio_asset_lineage_violation AS
SELECT
    a.id AS asset_id,
    count(l.id) AS parent_count,
    coalesce(max(l.depth), 0) AS max_depth,
    CASE
        WHEN a.asset_kind IN ('stem', 'mix') AND count(l.id) = 0 THEN 'lineage_required'
        WHEN count(l.id) > 64 THEN 'max_parents_per_asset'
        WHEN coalesce(max(l.depth), 0) > 32 THEN 'max_path_depth'
    END AS invariant
FROM audio_asset a
LEFT JOIN lineage l ON l.child_asset_id = a.id
GROUP BY a.id, a.asset_kind
HAVING (a.asset_kind IN ('stem', 'mix') AND count(l.id) = 0)
    OR count(l.id) > 64
    OR coalesce(max(l.depth), 0) > 32;

COMMENT ON VIEW audio_asset_lineage_violation IS
    'Requirement 19.7 verification query. The invariant holds iff this view returns no rows.';
