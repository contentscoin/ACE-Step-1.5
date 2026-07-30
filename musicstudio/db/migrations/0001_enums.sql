-- 0001 — enum types and the product-layer error classes.
--
-- Design §4.1 (ER diagram), §4.2 (derivation types). Requirements 19.1, 19.6.
-- Members and their order mirror `domain/asset-kind.ts` and
-- `domain/derivation-type.ts`; `test/unit/schema-parity.test.ts` fails on drift.

CREATE TYPE asset_kind AS ENUM (
    'song',
    'bgm',
    'sfx',
    'dialogue',
    'stem',
    'mix'
);

COMMENT ON TYPE asset_kind IS
    'Requirement 19.1: every Audio_Asset carries exactly one of these kinds.';

CREATE TYPE derivation_type AS ENUM (
    'cover',
    'repaint',
    'extract',
    'lego',
    'complete',
    'stem_split',
    'mixdown',
    'effect_apply',
    'voice_convert'
);

COMMENT ON TYPE derivation_type IS
    'Design §4.2 / Requirement 19.6: exactly one derivation type per lineage edge.';

-- Custom SQLSTATE classes, chosen so a caught error names the requirement it
-- came from:
--   MS019 — Audio_Asset / lineage invariant (Requirement 19)
--   MS033 — commercial-use propagation (Requirement 33)
--   MS018 — audit log append-only / retention (Requirement 18, design §4.4)
