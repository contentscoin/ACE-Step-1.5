-- 0012 — Voice_Profile identity, reference samples and the preset voice catalogue
-- (Requirements 26.1, 26.2, 26.3, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11).
--
-- **This extends the row `0011_voice_consent.sql` created; it does not create a second
-- one.** 0011 owns `voice_profile.consent_state` and the withdrawal context and says in as
-- many words that task 2.7 adds "profile_type (preset/cloned), name, reference samples and
-- engine binding to this row" — so the columns are added by `ALTER TABLE` and no second
-- lifecycle flag exists anywhere.
--
-- Thin wrapper over the rules stated in `domain/voice/`. Same bounds, same format list,
-- same type vocabulary:
--
--   profile types         domain/voice/profile.ts
--   name / sample bounds  domain/voice/profile.ts
--   sample requirements   domain/voice/reference-sample.ts
--   catalogue entry       domain/voice/voice-catalogue.ts
--
-- `test/unit/voice/profile-schema-parity.test.ts` fails if the two sides drift, and it
-- needs no database.
--
-- ### What is *not* here
--
-- - The 60 % speech-ratio check of 26.5 and the sample-rate floor of 26.3 are **not** SQL
--   constraints on `voice_reference_sample`. They are judgements about the *upload*, made
--   before the row exists (see `services/voice/profile-service.ts`): a row only exists for
--   a sample that already passed. The measured values are stored so an audit can re-check
--   them, and the two bounds a stored row can still violate — length and format — are
--   CHECKed.
-- - The dialogue asset's line timings (25.14, 27.14) are not here either: `audio_asset` has
--   no dialogue metadata column yet, and Library_Service is task 5.1. They live behind
--   `DialogueRenditionStorePort` until then.
--
-- Error class:
--   MS026 — Voice_Profile consent and identity invariant (Requirement 26), the same class
--           0011 declares, because a caller cannot usefully tell 26.7's bound from 26.19's.

-- Requirement 26.1 / `domain/voice/profile.ts`.
CREATE TYPE voice_profile_type AS ENUM (
    'cloned',
    'preset'
);

COMMENT ON TYPE voice_profile_type IS
    'Requirement 26.1/26.9: a profile is cloned from reference samples or taken from the '
    'preset catalogue. Mirrors domain/voice/profile.ts.';

-- Requirement 26.3 / `domain/voice/reference-sample.ts`.
CREATE TYPE reference_sample_format AS ENUM (
    'wav',
    'mp3',
    'flac'
);

-- ---------------------------------------------------------------------------
-- Voice_Profile: the identity slice (task 2.7)
-- ---------------------------------------------------------------------------

ALTER TABLE voice_profile
    -- Nullable with no default on purpose: every row 0011 could have created was created by
    -- 2.7's own path, which always supplies a type, and a default would let a future writer
    -- create an untyped profile without noticing.
    ADD COLUMN profile_type voice_profile_type,
    -- Requirement 26.1 — 1자 이상 64자 이하.
    ADD COLUMN name text,
    -- Requirement 26.10 — the catalogue engine a `preset` profile is fixed to. NULL for a
    -- clone, which is what makes 26.11's refusal a question about one column rather than a
    -- lookup.
    ADD COLUMN bound_engine_id text,
    -- Requirement 26.9 — the catalogue entry a `preset` profile names.
    ADD COLUMN preset_voice_id text,
    ADD COLUMN preset_language_code text,
    -- Requirement 26.8 — the combined voice prompt handle, once two samples exist. Erased
    -- by Requirement 26.21's `VoiceDataErasurePort`, which is why nothing here deletes it.
    ADD COLUMN voice_prompt_id text;

COMMENT ON COLUMN voice_profile.bound_engine_id IS
    'Requirement 26.10: a preset profile''s fixed engine. NULL for a cloned profile, which '
    'may use any engine supporting the requested language (Requirement 25.3).';

ALTER TABLE voice_profile
    -- Requirement 26.1, measured on the trimmed value the service stores.
    ADD CONSTRAINT voice_profile_name_length CHECK (
        name IS NULL
        OR (char_length(btrim(name)) BETWEEN 1 AND 64)
    ),
    -- Requirement 26.10/26.11: exactly the preset arm carries the catalogue fields, and
    -- exactly the cloned arm does not. Stated as one biconditional so neither a locked clone
    -- nor an unlocked preset can be written.
    ADD CONSTRAINT voice_profile_preset_fields CHECK (
        profile_type IS NULL
        OR (profile_type = 'preset') = (
            bound_engine_id IS NOT NULL
            AND preset_voice_id IS NOT NULL
            AND preset_language_code IS NOT NULL
        )
    ),
    -- Requirement 27.3's ISO 639-1 shape, so a catalogue entry cannot carry `korean`.
    ADD CONSTRAINT voice_profile_preset_language_shape CHECK (
        preset_language_code IS NULL OR preset_language_code ~ '^[a-z]{2}$'
    );

-- ---------------------------------------------------------------------------
-- Reference samples (Requirements 26.2, 26.3, 26.6, 26.7)
-- ---------------------------------------------------------------------------

CREATE TABLE voice_reference_sample (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    voice_profile_id uuid NOT NULL REFERENCES voice_profile (id) ON DELETE CASCADE,
    -- The staged upload this row was promoted from, so 26.21's erasure can find the object.
    upload_id text NOT NULL,

    -- Requirement 26.2, milliseconds.
    duration_ms integer NOT NULL,
    -- Requirement 26.3.
    format reference_sample_format NOT NULL,
    sample_rate integer NOT NULL,
    -- Requirement 26.5's measurement, stored so an audit can re-derive the ratio. Not a
    -- CHECK: see the module comment on why the ratio is judged before the row exists.
    speech_duration_ms integer NOT NULL,
    -- Requirement 26.6 — 참조 텍스트. Empty when the transcriber could not answer; see the
    -- note in `services/voice/profile-service.ts`.
    reference_text text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),

    -- One row per upload per profile: promoting the same upload twice would double-count it
    -- against Requirement 26.7's bound.
    UNIQUE (voice_profile_id, upload_id),

    -- Requirement 26.2 — 6초 이상 120초 이하.
    CONSTRAINT voice_reference_sample_duration CHECK (duration_ms BETWEEN 6000 AND 120000),
    -- Requirement 26.3 — 16000Hz 이상. No upper bound is stated by 26.3 and none is invented.
    CONSTRAINT voice_reference_sample_rate CHECK (sample_rate >= 16000),
    CONSTRAINT voice_reference_sample_speech_measurable CHECK (
        speech_duration_ms BETWEEN 0 AND duration_ms
    )
);

COMMENT ON TABLE voice_reference_sample IS
    'Requirements 26.2-26.7: the reference samples a cloned Voice_Profile is built from, '
    '1-10 per profile. Erased with the profile under Requirement 26.21.';

CREATE INDEX voice_reference_sample_profile_idx
    ON voice_reference_sample (voice_profile_id);

-- Requirement 26.7 — 1개 이상 10개 이하, enforced at write time so no path can exceed it.
-- The *lower* bound cannot be a row constraint (a profile has zero samples for the instant
-- between its creation and its first promotion), so it is the service's, exactly as
-- Requirement 26.19's lower bound is.
CREATE OR REPLACE FUNCTION voice_reference_sample_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_type voice_profile_type;
    v_count integer;
BEGIN
    SELECT profile_type INTO v_type FROM voice_profile WHERE id = NEW.voice_profile_id;

    -- A preset profile is a catalogue entry; it has no speaker's audio to hold.
    IF v_type = 'preset' THEN
        RAISE EXCEPTION
            'a preset Voice_Profile stores no reference samples (Requirement 26.9)'
            USING ERRCODE = 'MS026';
    END IF;

    SELECT count(*) INTO v_count
      FROM voice_reference_sample
     WHERE voice_profile_id = NEW.voice_profile_id;

    IF v_count + 1 > 10 THEN
        RAISE EXCEPTION
            'a Voice_Profile stores at most 10 reference samples (Requirement 26.7), received %',
            v_count + 1
            USING ERRCODE = 'MS026';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER voice_reference_sample_bounds
    BEFORE INSERT ON voice_reference_sample
    FOR EACH ROW
    EXECUTE FUNCTION voice_reference_sample_guard();

-- Requirement 26.8 — does this profile need a combined voice prompt? The SQL mirror of
-- `needsCombinedPrompt`, true from the second sample onwards.
CREATE OR REPLACE FUNCTION voice_profile_needs_combined_prompt(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT count(*) >= 2 FROM voice_reference_sample WHERE voice_profile_id = p_profile_id;
$$;

COMMENT ON FUNCTION voice_profile_needs_combined_prompt IS
    'Requirement 26.8: a single-sample profile uses that sample directly, so the combined '
    'prompt is needed only from the second sample onwards.';

-- ---------------------------------------------------------------------------
-- The preset voice catalogue (Requirements 26.9, 26.10)
-- ---------------------------------------------------------------------------

CREATE TABLE preset_voice (
    voice_id text PRIMARY KEY,
    -- Requirement 26.9's three fields, and 26.10's binding: the entry *is* the binding.
    engine_id text NOT NULL,
    language_code text NOT NULL,
    display_name text NOT NULL,

    CONSTRAINT preset_voice_language_shape CHECK (language_code ~ '^[a-z]{2}$'),
    CONSTRAINT preset_voice_display_name CHECK (char_length(btrim(display_name)) > 0)
);

COMMENT ON TABLE preset_voice IS
    'Requirement 26.9: the predefined voice catalogue, each entry carrying an engine '
    'identifier, a voice identifier and a language code. Seeded from '
    'domain/voice/voice-catalogue.ts.';

-- Requirement 26.10 — a `preset` profile's engine and language come from its catalogue
-- entry and from nowhere else. Enforced rather than trusted, because 26.11's refusal is only
-- meaningful if the stored binding is the catalogue's.
CREATE OR REPLACE FUNCTION voice_profile_preset_binding_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_engine text;
    v_language text;
BEGIN
    IF NEW.profile_type IS DISTINCT FROM 'preset' THEN
        RETURN NEW;
    END IF;

    SELECT engine_id, language_code INTO v_engine, v_language
      FROM preset_voice
     WHERE voice_id = NEW.preset_voice_id;

    IF v_engine IS NULL THEN
        RAISE EXCEPTION
            'no preset voice % exists (Requirement 26.9)', NEW.preset_voice_id
            USING ERRCODE = 'MS026';
    END IF;

    IF NEW.bound_engine_id <> v_engine OR NEW.preset_language_code <> v_language THEN
        RAISE EXCEPTION
            'a preset Voice_Profile is fixed to its catalogue engine % and language % (Requirement 26.10)',
            v_engine, v_language
            USING ERRCODE = 'MS026';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER voice_profile_preset_binding
    BEFORE INSERT OR UPDATE OF profile_type, bound_engine_id, preset_voice_id, preset_language_code
    ON voice_profile
    FOR EACH ROW
    EXECUTE FUNCTION voice_profile_preset_binding_guard();
