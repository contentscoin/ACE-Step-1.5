-- 0006 — Lineage invariant enforcement (design §4.2; Requirements 19.6, 19.7, 19.13).
--
-- Thin wrapper over the rules stated in `domain/lineage/invariants.ts`. Same five
-- rules, same limits, same rejection payload (violated invariant + offending
-- asset ids), nothing more:
--
--   no_self_derivation      CHECK lineage_no_self_derivation (0005)
--   unique_derivation_edge  UNIQUE lineage_unique_edge       (0005)
--   max_parents_per_asset   lineage_guard(), limit 64
--   acyclic                 lineage_guard(), depth-first walk over input edges
--   max_path_depth          lineage_guard(), limit 32
--   lineage_required        audio_asset_require_lineage(), stem/mix need >= 1 input
--
-- Traversals stop at 33 edges: one past the legal maximum, which is enough to
-- observe an over-long path and a hard stop for an already-malformed graph.

-- Requirement 19.13: reject with the violated invariant and the asset ids
-- involved, leaving existing lineage untouched (the statement aborts).
CREATE OR REPLACE FUNCTION lineage_reject(
    p_invariant text,
    p_asset_ids uuid[],
    p_limit integer,
    p_observed integer
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'lineage invariant violation: %', p_invariant
        USING ERRCODE = 'MS019',
              DETAIL = json_build_object(
                  'invariant', p_invariant,
                  'assetIds', p_asset_ids,
                  'limit', p_limit,
                  'observed', p_observed
              )::text,
              HINT = 'request rejected; existing lineage is unchanged (Requirement 19.13)';
END;
$$;

CREATE OR REPLACE FUNCTION lineage_array_reverse(p_ids uuid[])
RETURNS uuid[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT array_agg(id ORDER BY ord DESC)
    FROM unnest(p_ids) WITH ORDINALITY AS t (id, ord);
$$;

-- Longest chain of input assets above p_asset, as [p_asset, parent, ..., root].
CREATE OR REPLACE FUNCTION lineage_longest_ancestor_path(p_asset uuid)
RETURNS uuid[]
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE up (asset_id, path, depth) AS (
        SELECT p_asset, ARRAY[p_asset], 0
        UNION ALL
        SELECT l.parent_asset_id, up.path || l.parent_asset_id, up.depth + 1
        FROM up
        JOIN lineage l ON l.child_asset_id = up.asset_id
        WHERE NOT (l.parent_asset_id = ANY (up.path))
          AND up.depth < 33
    )
    SELECT path FROM up ORDER BY depth DESC LIMIT 1;
$$;

-- Longest chain of derivatives below p_asset, as [p_asset, child, ..., leaf].
CREATE OR REPLACE FUNCTION lineage_longest_descendant_path(p_asset uuid)
RETURNS uuid[]
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE down (asset_id, path, depth) AS (
        SELECT p_asset, ARRAY[p_asset], 0
        UNION ALL
        SELECT l.child_asset_id, down.path || l.child_asset_id, down.depth + 1
        FROM down
        JOIN lineage l ON l.parent_asset_id = down.asset_id
        WHERE NOT (l.child_asset_id = ANY (down.path))
          AND down.depth < 33
    )
    SELECT path FROM down ORDER BY depth DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION lineage_ancestor_depth(p_asset uuid)
RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT coalesce(array_length(lineage_longest_ancestor_path(p_asset), 1), 1) - 1;
$$;

CREATE OR REPLACE FUNCTION lineage_descendant_depth(p_asset uuid)
RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT coalesce(array_length(lineage_longest_descendant_path(p_asset), 1), 1) - 1;
$$;

-- Shortest walk from p_from up to p_target over input edges, or NULL when
-- p_target is not an ancestor of p_from. Used for cycle detection.
CREATE OR REPLACE FUNCTION lineage_ancestor_path(p_from uuid, p_target uuid)
RETURNS uuid[]
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE up (asset_id, path, depth) AS (
        SELECT p_from, ARRAY[p_from], 0
        UNION ALL
        SELECT l.parent_asset_id, up.path || l.parent_asset_id, up.depth + 1
        FROM up
        JOIN lineage l ON l.child_asset_id = up.asset_id
        WHERE NOT (l.parent_asset_id = ANY (up.path))
          AND up.depth < 33
    )
    SELECT path FROM up WHERE asset_id = p_target ORDER BY depth LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION lineage_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_parent_count integer;
    v_cycle_path uuid[];
    v_ancestor_depth integer;
    v_path_depth integer;
BEGIN
    -- no_self_derivation. Also guarded by CHECK lineage_no_self_derivation, but a
    -- BEFORE trigger runs first, so it has to name the invariant itself rather
    -- than let the self edge be reported as a degenerate cycle (Requirement 19.13).
    IF NEW.child_asset_id = NEW.parent_asset_id THEN
        PERFORM lineage_reject(
            'no_self_derivation', ARRAY[NEW.child_asset_id], 0, 1
        );
    END IF;

    -- max_parents_per_asset (Requirement 19.6).
    SELECT count(*) INTO v_parent_count
    FROM lineage
    WHERE child_asset_id = NEW.child_asset_id;

    IF v_parent_count + 1 > 64 THEN
        PERFORM lineage_reject(
            'max_parents_per_asset', ARRAY[NEW.child_asset_id], 64, v_parent_count + 1
        );
    END IF;

    -- acyclic (Requirements 19.7, 19.13): the new edge child -> parent closes a
    -- cycle exactly when the child is already an input of the parent.
    v_cycle_path := lineage_ancestor_path(NEW.parent_asset_id, NEW.child_asset_id);
    IF v_cycle_path IS NOT NULL THEN
        PERFORM lineage_reject(
            'acyclic',
            v_cycle_path || NEW.parent_asset_id,
            0,
            coalesce(array_length(v_cycle_path, 1), 0)
        );
    END IF;

    -- max_path_depth (Requirement 19.7): adding an edge can only lengthen paths
    -- that run through it, so bounding that one path bounds the whole graph.
    v_ancestor_depth := lineage_ancestor_depth(NEW.parent_asset_id);
    v_path_depth := lineage_descendant_depth(NEW.child_asset_id) + 1 + v_ancestor_depth;

    IF v_path_depth > 32 THEN
        PERFORM lineage_reject(
            'max_path_depth',
            lineage_array_reverse(lineage_longest_descendant_path(NEW.child_asset_id))
                || lineage_longest_ancestor_path(NEW.parent_asset_id),
            32,
            v_path_depth
        );
    END IF;

    -- `depth` is derived, so whatever the caller supplied is replaced.
    NEW.depth := v_ancestor_depth + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER lineage_guard_before_insert
    BEFORE INSERT ON lineage
    FOR EACH ROW
    EXECUTE FUNCTION lineage_guard();

-- A new edge lengthens the input chains of everything below the child, so their
-- stored depths are recomputed. Bounded by the depth limit, hence by 32 levels.
CREATE OR REPLACE FUNCTION lineage_refresh_depths()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE lineage l
       SET depth = lineage_ancestor_depth(l.parent_asset_id) + 1
     WHERE l.child_asset_id IN (
               WITH RECURSIVE down (asset_id, depth) AS (
                   SELECT NEW.child_asset_id, 0
                   UNION
                   SELECT e.child_asset_id, down.depth + 1
                   FROM down
                   JOIN lineage e ON e.parent_asset_id = down.asset_id
                   WHERE down.depth < 33
               )
               SELECT asset_id FROM down
           )
       AND l.depth <> lineage_ancestor_depth(l.parent_asset_id) + 1;
    RETURN NULL;
END;
$$;

CREATE TRIGGER lineage_refresh_depths_after_insert
    AFTER INSERT ON lineage
    FOR EACH ROW
    EXECUTE FUNCTION lineage_refresh_depths();

-- Lineage is provenance: Requirement 33.7 keeps it unmodified after the fact, so
-- an edge's identity cannot be rewritten. Only the derived `depth` may change.
CREATE OR REPLACE FUNCTION lineage_reject_rewrite()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'lineage edges are immutable (Requirement 33.7): delete and re-derive instead'
        USING ERRCODE = 'MS019';
END;
$$;

CREATE TRIGGER lineage_no_rewrite
    BEFORE UPDATE ON lineage
    FOR EACH ROW
    WHEN (
        OLD.child_asset_id <> NEW.child_asset_id
        OR OLD.parent_asset_id <> NEW.parent_asset_id
        OR OLD.derivation_type <> NEW.derivation_type
    )
    EXECUTE FUNCTION lineage_reject_rewrite();

-- lineage_required (Requirement 19.7): a stem or mix always has at least one
-- input asset. Deferred to commit time because the asset row is inserted before
-- its lineage rows within the same transaction.
CREATE OR REPLACE FUNCTION audio_asset_require_lineage()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.asset_kind IN ('stem', 'mix')
       AND NOT EXISTS (SELECT 1 FROM lineage WHERE child_asset_id = NEW.id) THEN
        PERFORM lineage_reject('lineage_required', ARRAY[NEW.id], 1, 0);
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER audio_asset_require_lineage_trg
    AFTER INSERT ON audio_asset
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION audio_asset_require_lineage();
