-- 0020 — where an Audio_Asset's audio actually is (track B1).
--
-- `audio_asset` described everything about a stored asset except the one thing that makes
-- it stored: its bytes had no address. Duration, sample rate, channels, provenance and the
-- licence ruling were all there; the object key was not. Nothing noticed, because the only
-- implementation of `LibraryAssetStore` was in memory, and an in-memory store holds the
-- audio in the same map as the metadata.
--
-- `services/library/ports.ts` has always declared it:
--
--     /** Where the stored audio lives. `null` once Requirement 11.8 has purged it. */
--     readonly objectKey: string | null;
--
-- Nullable, and that nullability is load-bearing rather than convenience. Requirement 11.8
-- purges the audio on a retention sweep while the row survives — so "the asset exists and
-- its bytes do not" is a state the product has, and a NOT NULL column would force either a
-- sentinel key that points at nothing or deleting rows 11.8 says to keep.
--
-- No backfill: there are no rows. Nothing has ever written this table.

ALTER TABLE audio_asset ADD COLUMN object_key text;

-- Present means addressable. An empty string is the failure this guards: it reads as a key
-- everywhere a key is expected and resolves nowhere, which surfaces as a download that
-- succeeds with no bytes rather than as a missing asset.
ALTER TABLE audio_asset ADD CONSTRAINT audio_asset_object_key_shape CHECK (
    object_key IS NULL OR char_length(object_key) BETWEEN 1 AND 1024
);

-- The purge sweep asks for assets whose audio is still present; without this it scans the
-- table on every pass. Partial, because the rows that interest it are the minority once a
-- library ages.
CREATE INDEX audio_asset_object_key_present_idx
    ON audio_asset (deleted_at)
    WHERE object_key IS NOT NULL;

COMMENT ON COLUMN audio_asset.object_key IS
    'Object store address of the stored audio; NULL once Requirement 11.8 has purged it.';
