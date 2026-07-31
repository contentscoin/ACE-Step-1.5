-- 0011 — Voice_Consent_Record, Voice_Profile consent state and the two-stage
-- withdrawal state machine (Requirements 26.12–26.23, 26.26–26.36; design §9.2, §9.3).
--
-- Thin wrapper over the rules stated in `domain/voice/`. Same states, same transition
-- table, same windows, same retention floor:
--
--   states                domain/voice/consent-state.ts
--   transitions           domain/voice/withdrawal-machine.ts
--   windows / limits      domain/voice/windows.ts
--   consent items         domain/voice/consent-record.ts
--   30-day claim cap      domain/voice/withdrawal-quota.ts
--   5-year retention      domain/voice/retention.ts
--
-- `test/unit/voice/schema-parity.test.ts` fails if the two sides drift, and it needs no
-- database.
--
-- Scope split with task 2.7: **this migration owns the consent state and the consent
-- record; task 2.7 owns Voice_Profile creation.** `voice_profile` is created here with
-- only the columns Requirement 26.12–26.36 need, so 2.7 adds `profile_type`
-- (`preset`/`cloned`), the profile name, the reference samples and the engine binding to
-- the same row instead of introducing a second lifecycle flag.
--
-- Asset visibility (26.30, 26.33) is **not** here: `audio_asset` has no publication
-- column yet, because Sharing_Service is task 5.3. The rule this side states is
-- `voice_profile_unpublish_due(state)` — true only for `사용_중지` — which is the SQL
-- mirror of `mutatesAssetVisibility` and the predicate 5.3 will apply.
--
-- Error class:
--   MS026 — Voice_Profile consent and withdrawal invariant (Requirement 26),
--           alongside the MS002/MS016/MS018/MS019/MS033 classes declared in
--           0001_enums.sql.

-- Design §9.2. Labels are the design's own Korean names; Requirement 26 refers to the
-- states by these names throughout, and a translated enum would put a glossary between
-- the criteria and the data.
CREATE TYPE voice_profile_consent_state AS ENUM (
    '정상',
    '잠정_사용_제한',
    '사용_중지',
    '삭제됨'
);

COMMENT ON TYPE voice_profile_consent_state IS
    'Design §9.2: Voice_Profile consent state. Mirrors domain/voice/consent-state.ts. '
    '잠정_사용_제한 and 사용_중지 both refuse generation (26.29); only 사용_중지 changes '
    'asset visibility (26.30 vs 26.33); 삭제됨 answers 404 (26.22).';

-- Design §9.3 — 화자 관계 구분.
CREATE TYPE speaker_relationship AS ENUM (
    '본인',
    '제3자_허가보유'
);

CREATE TYPE consent_record_kind AS ENUM (
    'clone',
    'voice_convert'
);

CREATE TYPE withdrawal_claim_outcome AS ENUM (
    'pending',
    'verified',
    'rejected',
    'expired'
);

CREATE TYPE identity_evidence_kind AS ENUM (
    'challenge_phrase_recording',
    'identity_document'
);

-- ---------------------------------------------------------------------------
-- Voice_Profile: the consent-state slice (task 2.7 extends this row)
-- ---------------------------------------------------------------------------

CREATE TABLE voice_profile (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,

    -- Requirement 26.28/26.32/26.34 state and the context the transitions need.
    consent_state voice_profile_consent_state NOT NULL DEFAULT '정상',
    -- Requirement 26.34's restore target, recorded rather than assumed to be 정상.
    state_before_withdrawal voice_profile_consent_state,
    -- Requirement 26.28's 접수 시각; the 24-hour transition budget runs from it.
    withdrawal_received_at timestamptz,
    -- Requirement 26.31's 14-day clock origin.
    provisional_since timestamptz,

    -- Requirement 26.21/26.22/26.14: deletion instant, and the retention origin.
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- The context fields are only meaningful in 잠정_사용_제한; carrying them in any
    -- other state would let a stale 14-day origin survive a revert.
    CONSTRAINT voice_profile_provisional_context CHECK (
        (consent_state = '잠정_사용_제한')
        = (provisional_since IS NOT NULL AND state_before_withdrawal IS NOT NULL)
    ),
    -- Requirement 26.22: 삭제됨 and deleted_at are the same fact.
    CONSTRAINT voice_profile_deleted_at_matches_state CHECK (
        (consent_state = '삭제됨') = (deleted_at IS NOT NULL)
    )
);

COMMENT ON TABLE voice_profile IS
    'Requirement 26: consent-state slice of a Voice_Profile. Task 6.2 owns consent_state '
    'and the withdrawal context; task 2.7 adds profile_type (preset/cloned), name, '
    'reference samples and engine binding to this row.';

COMMENT ON COLUMN voice_profile.consent_state IS
    'Design §9.2 state. Mirrors domain/voice/consent-state.ts.';

CREATE INDEX voice_profile_owner_idx ON voice_profile (owner_id);

-- Requirement 26.34's sweep: profiles whose 14-day window may have closed.
CREATE INDEX voice_profile_provisional_idx
    ON voice_profile (provisional_since)
    WHERE consent_state = '잠정_사용_제한';

-- Requirements 26.18, 26.19 — the share list. A separate table so the 1–50 bound is
-- countable and each change is a row rather than an array rewrite; the owner is never a
-- member (26.18 gives them the permission unconditionally).
CREATE TABLE voice_profile_share (
    voice_profile_id uuid NOT NULL REFERENCES voice_profile (id) ON DELETE CASCADE,
    shared_user_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (voice_profile_id, shared_user_id)
);

COMMENT ON TABLE voice_profile_share IS
    'Requirement 26.19: 1–50 users the owner shared the profile with. Owner excluded.';

-- Requirement 26.19 — 50명 이하, enforced at write time so no path can exceed it.
CREATE OR REPLACE FUNCTION voice_profile_share_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_owner uuid;
    v_count integer;
BEGIN
    SELECT owner_id INTO v_owner FROM voice_profile WHERE id = NEW.voice_profile_id;

    IF v_owner = NEW.shared_user_id THEN
        RAISE EXCEPTION
            'the owner already holds use permission and must not be shared with (Requirement 26.18)'
            USING ERRCODE = 'MS026';
    END IF;

    SELECT count(*) INTO v_count
      FROM voice_profile_share
     WHERE voice_profile_id = NEW.voice_profile_id;

    IF v_count + 1 > 50 THEN
        RAISE EXCEPTION
            'a shared Voice_Profile may name at most 50 users (Requirement 26.19), received %',
            v_count + 1
            USING ERRCODE = 'MS026';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER voice_profile_share_bounds
    BEFORE INSERT ON voice_profile_share
    FOR EACH ROW
    EXECUTE FUNCTION voice_profile_share_guard();

-- ---------------------------------------------------------------------------
-- Voice_Consent_Record — append-only, five-year retention (26.12–26.15, 26.26)
-- ---------------------------------------------------------------------------

CREATE TABLE voice_consent_record (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_kind consent_record_kind NOT NULL,

    -- Design §9.3's nine fields.
    submitter_id uuid NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    is_speaker boolean,
    has_explicit_permission boolean,
    prohibited_use_confirmation boolean NOT NULL,
    speaker_relationship speaker_relationship,
    speaker_identity text,
    withdrawal_contact text,
    target_profile_id uuid NOT NULL REFERENCES voice_profile (id) ON DELETE RESTRICT,

    -- Requirement 26.26's second item, for `voice_convert` records.
    source_rights_confirmation boolean,

    -- Requirement 26.13: 화자 본인 여부와 명시적 허가 보유 여부가 *모두* 부정이면 거부.
    -- Either one alone is a sufficient basis — the speaker needs no third-party
    -- permission, and a permitted third party is not the speaker — so this is a
    -- disjunction, not a conjunction.
    CONSTRAINT voice_consent_clone_basis CHECK (
        record_kind <> 'clone'
        OR (is_speaker OR has_explicit_permission)
    ),
    -- Requirement 26.12/26.13: the clone items are all mandatory.
    CONSTRAINT voice_consent_clone_items_present CHECK (
        record_kind <> 'clone'
        OR (
            is_speaker IS NOT NULL
            AND has_explicit_permission IS NOT NULL
            AND speaker_relationship IS NOT NULL
        )
    ),
    -- Requirement 26.12/26.26: the confirmation is never negative in a stored record.
    CONSTRAINT voice_consent_prohibited_use_affirmed CHECK (prohibited_use_confirmation),
    -- Requirement 26.14: a 제3자_허가보유 record without a speaker identity and a
    -- withdrawal contact would leave the speaker no route to 26.28.
    CONSTRAINT voice_consent_third_party_contactable CHECK (
        speaker_relationship IS DISTINCT FROM '제3자_허가보유'
        OR (
            speaker_identity IS NOT NULL AND char_length(btrim(speaker_identity)) > 0
            AND withdrawal_contact IS NOT NULL AND char_length(btrim(withdrawal_contact)) > 0
        )
    ),
    -- A 본인 record that denies being the speaker contradicts itself.
    CONSTRAINT voice_consent_self_record_consistent CHECK (
        speaker_relationship IS DISTINCT FROM '본인' OR is_speaker
    ),
    -- Requirement 26.26: both conversion items present and affirmative.
    CONSTRAINT voice_consent_convert_items CHECK (
        record_kind <> 'voice_convert' OR source_rights_confirmation
    )
);

COMMENT ON TABLE voice_consent_record IS
    'Requirement 26.12–26.15, 26.26 / design §9.3: immutable consent record, retained '
    'five years past target profile deletion.';

CREATE INDEX voice_consent_record_profile_idx
    ON voice_consent_record (target_profile_id, submitted_at DESC);

-- Requirement 26.14 — 저장된 항목 값을 수정 불가 상태로 유지한다.
--
-- Same technique task 1.1 used for the audit log: refuse the mutation in the database so
-- immutability is not a convention every writer has to observe. DELETE is refused too,
-- and the retention function below is the only sanctioned route to removal.
CREATE OR REPLACE FUNCTION voice_consent_record_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'voice_consent_record is immutable (Requirement 26.14): % is not permitted', TG_OP
        USING ERRCODE = 'MS026';
END;
$$;

CREATE TRIGGER voice_consent_record_no_update
    BEFORE UPDATE ON voice_consent_record
    FOR EACH ROW
    EXECUTE FUNCTION voice_consent_record_reject_mutation();

CREATE TRIGGER voice_consent_record_no_delete
    BEFORE DELETE ON voice_consent_record
    FOR EACH ROW
    EXECUTE FUNCTION voice_consent_record_reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON voice_consent_record FROM PUBLIC;

-- Requirement 26.14 — records eligible for deletion: the target profile is deleted and
-- five years have passed. A retention shorter than the floor is a programming error, not
-- a setting, exactly as `audit_log_prunable_partitions` treats its 365-day floor.
CREATE OR REPLACE FUNCTION voice_consent_record_prunable(
    p_retain_days integer DEFAULT 1826,
    p_now timestamptz DEFAULT now()
)
RETURNS TABLE (consent_record_id uuid, target_profile_id uuid, prunable_from timestamptz)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_retain_days < 1826 THEN
        RAISE EXCEPTION
            'Voice_Consent_Record retention must be at least 1826 days past profile deletion (Requirement 26.14), received %',
            p_retain_days
            USING ERRCODE = 'MS026';
    END IF;

    RETURN QUERY
    SELECT r.id,
           r.target_profile_id,
           p.deleted_at + make_interval(days => p_retain_days)
      FROM voice_consent_record r
      JOIN voice_profile p ON p.id = r.target_profile_id
     -- A record for a live profile never becomes prunable, which is the correct and the
     -- safe reading of "삭제 시각으로부터 5년간".
     WHERE p.deleted_at IS NOT NULL
       AND p.deleted_at + make_interval(days => p_retain_days) <= p_now
     ORDER BY 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- Withdrawal claims and the two-stage state machine (26.28–26.36)
-- ---------------------------------------------------------------------------

CREATE TABLE voice_withdrawal_claim (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    voice_profile_id uuid NOT NULL REFERENCES voice_profile (id) ON DELETE CASCADE,
    -- NULL when the claim arrived through the contact recorded on a 제3자_허가보유
    -- record rather than from a signed-in account. Requirement 26.28 admits both
    -- routes, and requiring an account would shut out the very speaker the record
    -- exists to protect.
    claimant_account_id uuid REFERENCES account (id) ON DELETE SET NULL,
    intake_channel text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    outcome withdrawal_claim_outcome NOT NULL DEFAULT 'pending',
    evidence_kind identity_evidence_kind,
    evidence_submitted_at timestamptz,

    CONSTRAINT voice_withdrawal_claim_channel CHECK (
        intake_channel IN ('recorded_contact', 'in_product')
    )
);

COMMENT ON TABLE voice_withdrawal_claim IS
    'Requirement 26.28/26.35: withdrawal claims, capped at 3 per profile per 30 days.';

CREATE INDEX voice_withdrawal_claim_profile_idx
    ON voice_withdrawal_claim (voice_profile_id, received_at DESC);

-- Requirement 26.35 — how many claims fall inside the rolling 30-day window.
--
-- Rolling, not calendar: a calendar window would let a claimant file three claims on the
-- last day of a month and three more the next day.
CREATE OR REPLACE FUNCTION voice_withdrawal_claims_in_window(
    p_profile_id uuid,
    p_now timestamptz DEFAULT now(),
    p_window_days integer DEFAULT 30
)
RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT count(*)::integer
      FROM voice_withdrawal_claim
     WHERE voice_profile_id = p_profile_id
       AND received_at > p_now - make_interval(days => p_window_days);
$$;

-- Requirement 26.35 — 다음 접수 가능 시각.
--
-- Derived from the *oldest* in-window claim, not the newest: using the newest would tell
-- the claimant to return 30 days after their most recent attempt, a longer ban than the
-- criterion states.
CREATE OR REPLACE FUNCTION voice_withdrawal_next_eligible_at(
    p_profile_id uuid,
    p_now timestamptz DEFAULT now(),
    p_window_days integer DEFAULT 30,
    p_limit integer DEFAULT 3
)
RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT received_at + make_interval(days => p_window_days)
      FROM (
        SELECT received_at,
               row_number() OVER (ORDER BY received_at DESC) AS rn
          FROM voice_withdrawal_claim
         WHERE voice_profile_id = p_profile_id
           AND received_at > p_now - make_interval(days => p_window_days)
      ) windowed
     WHERE rn = p_limit;
$$;

CREATE OR REPLACE FUNCTION voice_withdrawal_claim_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF voice_withdrawal_claims_in_window(NEW.voice_profile_id, NEW.received_at) >= 3 THEN
        RAISE EXCEPTION
            'a Voice_Profile accepts at most 3 withdrawal claims per 30 days (Requirement 26.35); next eligible at %',
            voice_withdrawal_next_eligible_at(NEW.voice_profile_id, NEW.received_at)
            USING ERRCODE = 'MS026';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER voice_withdrawal_claim_cap
    BEFORE INSERT ON voice_withdrawal_claim
    FOR EACH ROW
    EXECUTE FUNCTION voice_withdrawal_claim_guard();

-- Design §9.2 — the transition table, as one function, mirroring
-- `applyWithdrawalEvent`. Returns the destination state, or raises when the event does
-- not apply.
CREATE OR REPLACE FUNCTION voice_profile_state_after_event(
    p_current voice_profile_consent_state,
    p_event text,
    p_state_before_withdrawal voice_profile_consent_state DEFAULT NULL
)
RETURNS voice_profile_consent_state
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    -- Requirement 26.28.
    IF p_event = '동의_철회_접수' THEN
        IF p_current <> '정상' THEN
            RAISE EXCEPTION
                'a withdrawal claim only restricts a 정상 profile, not % (Requirement 26.28)',
                p_current
                USING ERRCODE = 'MS026';
        END IF;
        RETURN '잠정_사용_제한';
    END IF;

    -- Requirement 26.32.
    IF p_event = '신원_확인_성공' THEN
        IF p_current <> '잠정_사용_제한' THEN
            RAISE EXCEPTION
                'identity verification only applies in 잠정_사용_제한, not % (Requirement 26.32)',
                p_current
                USING ERRCODE = 'MS026';
        END IF;
        RETURN '사용_중지';
    END IF;

    -- Requirement 26.34.
    IF p_event IN ('신원_확인_실패', '신원_확인_기한_경과') THEN
        IF p_current <> '잠정_사용_제한' THEN
            RAISE EXCEPTION
                'a revert only applies in 잠정_사용_제한, not % (Requirement 26.34)',
                p_current
                USING ERRCODE = 'MS026';
        END IF;
        RETURN COALESCE(p_state_before_withdrawal, '정상'::voice_profile_consent_state);
    END IF;

    -- Design §9.2 terminal edge, and Requirement 26.21's owner deletion.
    IF p_event = '데이터_삭제_완료' THEN
        IF p_current <> '사용_중지' THEN
            RAISE EXCEPTION
                'erasure completion only applies in 사용_중지, not % (design §9.2)', p_current
                USING ERRCODE = 'MS026';
        END IF;
        RETURN '삭제됨';
    END IF;

    IF p_event = '소유자_삭제_요청' THEN
        IF p_current = '삭제됨' THEN
            RAISE EXCEPTION
                'the profile is already deleted (Requirement 26.21)'
                USING ERRCODE = 'MS026';
        END IF;
        RETURN '삭제됨';
    END IF;

    RAISE EXCEPTION 'unknown withdrawal event % (design §9.2)', p_event
        USING ERRCODE = 'MS026';
END;
$$;

-- Requirement 26.29 — the two states that refuse new generation.
CREATE OR REPLACE FUNCTION voice_profile_refuses_generation(
    p_state voice_profile_consent_state
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_state IN ('잠정_사용_제한', '사용_중지');
$$;

-- **Requirement 26.30 vs 26.33 — the crux, stated as one predicate.**
--
-- Both restricted states refuse new generation, but only 사용_중지 changes what the
-- public can see. This is the SQL mirror of `mutatesAssetVisibility` in
-- `domain/voice/withdrawal-machine.ts`; task 5.3's Sharing_Service applies it, and
-- `test/unit/voice/schema-parity.test.ts` fails if the two disagree.
CREATE OR REPLACE FUNCTION voice_profile_unpublish_due(
    p_state voice_profile_consent_state
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_state = '사용_중지';
$$;

COMMENT ON FUNCTION voice_profile_unpublish_due IS
    'Requirement 26.30/26.33: false in 잠정_사용_제한 — a provisional restriction never '
    'touches asset visibility — and true only in 사용_중지.';

-- Requirement 26.22 — a deleted profile answers 404, never 403.
CREATE OR REPLACE FUNCTION voice_profile_is_deleted(
    p_state voice_profile_consent_state
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_state = '삭제됨';
$$;

-- Which events apply in a state — the guard clauses of `applyWithdrawalEvent` without
-- the raise, so the trigger below can enumerate legal destinations from the same table
-- the service uses rather than from a second hand-written list.
CREATE OR REPLACE FUNCTION voice_profile_event_applies(
    p_state voice_profile_consent_state,
    p_event text
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_event
        WHEN '동의_철회_접수'      THEN p_state = '정상'
        WHEN '신원_확인_성공'      THEN p_state = '잠정_사용_제한'
        WHEN '신원_확인_실패'      THEN p_state = '잠정_사용_제한'
        WHEN '신원_확인_기한_경과' THEN p_state = '잠정_사용_제한'
        WHEN '데이터_삭제_완료'    THEN p_state = '사용_중지'
        WHEN '소유자_삭제_요청'    THEN p_state <> '삭제됨'
        ELSE false
    END;
$$;

-- Every state change goes through the transition table, so a state written by any path —
-- API, operator tool, backfill — is one design §9.2 allows.
CREATE OR REPLACE FUNCTION voice_profile_guard_state_transition()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_event text;
    v_legal boolean := false;
BEGIN
    IF NEW.consent_state = OLD.consent_state THEN
        RETURN NEW;
    END IF;

    FOREACH v_event IN ARRAY ARRAY[
        '동의_철회_접수', '신원_확인_성공', '신원_확인_실패',
        '신원_확인_기한_경과', '데이터_삭제_완료', '소유자_삭제_요청'
    ] LOOP
        IF voice_profile_event_applies(OLD.consent_state, v_event)
           AND voice_profile_state_after_event(
                   OLD.consent_state, v_event, OLD.state_before_withdrawal
               ) = NEW.consent_state
        THEN
            v_legal := true;
            EXIT;
        END IF;
    END LOOP;

    IF NOT v_legal THEN
        RAISE EXCEPTION
            'Voice_Profile consent state may not move from % to % (design §9.2)',
            OLD.consent_state, NEW.consent_state
            USING ERRCODE = 'MS026';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER voice_profile_state_transition
    BEFORE UPDATE OF consent_state ON voice_profile
    FOR EACH ROW
    EXECUTE FUNCTION voice_profile_guard_state_transition();
