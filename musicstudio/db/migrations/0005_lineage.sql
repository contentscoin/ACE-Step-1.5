-- 0005 — Lineage edges (design §4.1, §4.2).
--
-- One row per parent→child derivation. `depth` is derived, not supplied: the
-- trigger installed by 0006 computes it, so it can never disagree with the graph.
-- Requirements 19.6, 19.7.

CREATE TABLE lineage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE CASCADE,
    -- An input asset cannot be hard-deleted while a derivative still cites it;
    -- Requirement 11 soft-deletes instead.
    parent_asset_id uuid NOT NULL REFERENCES audio_asset (id) ON DELETE RESTRICT,
    derivation_type derivation_type NOT NULL,
    depth integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lineage_no_self_derivation CHECK (child_asset_id <> parent_asset_id),
    -- Requirement 19.7: path depth stays within 1..32.
    CONSTRAINT lineage_depth_range CHECK (depth BETWEEN 1 AND 32),
    CONSTRAINT lineage_unique_edge UNIQUE (child_asset_id, parent_asset_id)
);

CREATE INDEX lineage_parent_idx ON lineage (parent_asset_id);
CREATE INDEX lineage_child_idx ON lineage (child_asset_id);

COMMENT ON TABLE lineage IS
    'Design §4.2: acyclic derivation graph, path depth 1..32, at most 64 parents per asset.';
COMMENT ON COLUMN lineage.depth IS
    'Derived: longest input chain reaching child_asset_id through this edge. Assigned by lineage_guard().';
