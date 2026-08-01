-- 0016 — an Effect_Chain per Timeline_Clip (Requirements 29.31, 29.32).
--
-- Requirement 29.31 is a `WHERE` clause over a clip — "WHERE Timeline_Clip에 Effect_Chain이
-- 지정된 경우, THE Mixdown_Renderer SHALL …" — so a clip needs somewhere to keep one. 0015 has
-- no such column because nothing put a chain on a clip until now.
--
-- ### Why a new migration rather than an edit to 0015
--
-- Nothing in this repository has ever been applied to a real database, so editing 0015 would
-- work. It is still the wrong habit: a migration is a record of a schema change, and rewriting
-- one turns the history into a description of the present, which is exactly what a migration set
-- is *for* not being. `db/runner.ts` records applied files by id, so an edited 0015 would also be
-- silently skipped by any environment that had already run it.
--
-- ### Why `jsonb`, and why the column is nullable
--
-- Requirement 29.11 stores an `Effect_Chain` as an order-preserving JSON array, and 0013's
-- `effect_preset.chain` already stores one the same way — one representation for the structure,
-- so `Chain_Parser` and `Chain_Printer` read and write the same bytes wherever a chain is kept.
-- `jsonb` rather than `json`: the ordering that matters is the *array's*, which `jsonb` preserves,
-- and only object key order is normalised — which is harmless here because `chain.ts` fixes
-- parameter key order on entry anyway (Requirement 29.27).
--
-- NULL means "this clip has no chain", which is the `WHERE` of 29.31 not holding. The domain
-- models the same absence as an explicit `null` rather than a missing property
-- (`domain/timeline/project.ts`), and NULL is that value.
--
-- ### What the CHECK does and does not do
--
-- It enforces the two things a CHECK can see: the value is a JSON array, and its length is within
-- Requirement 29.13's 1–16. The *contents* — Requirement 29.1's eight kinds, and the parameter
-- ranges of 29.2–29.8 — are not checked here, and deliberately not: they are a table of eight
-- effects with 3–5 parameters each, and a CHECK restating them would be a second copy of
-- `domain/effects/registry.ts` that could disagree with it, with no parity test able to compare a
-- constraint expression against a TypeScript table. The registry is the single declaration
-- (mirrored in `dsp/src/musicstudio_dsp/effect_registry.json` with a bidirectional parity test),
-- `chainViolations` is the gate every write passes, and `apply_chain` validates again in the
-- worker. An empty array is refused rather than accepted-as-no-chain, so there is exactly one
-- representation of "no chain" and Requirement 28.33's reprint cannot depend on which was stored.
--
-- The 10 000 ms tail allowance of Requirement 29.32 is **not** here and is not a stored quantity
-- at all: it bounds the length of a processed `Generation_Version` (0004's row, enforced by
-- `services/effects/effects-service.ts`), and inside a mixdown no tail exists to bound — design
-- §6.3 cuts it at the clip's play length. See `domain/timeline/clip-effects.ts`.

ALTER TABLE timeline_clip
    ADD COLUMN effect_chain jsonb;

COMMENT ON COLUMN timeline_clip.effect_chain IS
    'Requirement 29.31: the Effect_Chain the Mixdown_Renderer applies to this clip''s trimmed audio before cutting to the play length. NULL means no chain. Item count 1-16 (Requirement 29.13); contents validated by domain/effects/registry.ts.';

ALTER TABLE timeline_clip
    ADD CONSTRAINT timeline_clip_effect_chain_shape CHECK (
        effect_chain IS NULL
        OR (
            jsonb_typeof(effect_chain) = 'array'
            AND jsonb_array_length(effect_chain) BETWEEN 1 AND 16
        )
    );

-- The lookup a mixdown makes: which clips of a project carry a chain, so the renderer's
-- consistency check (Requirement 29.31) does not scan every clip's jsonb.
CREATE INDEX timeline_clip_effect_chain_idx
    ON timeline_clip (project_id)
    WHERE effect_chain IS NOT NULL;
