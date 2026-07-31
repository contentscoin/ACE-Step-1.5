import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../../../db/runner';
import {
  CONSENT_RECORD_KINDS,
  SPEAKER_RELATIONSHIPS,
} from '../../../domain/voice/consent-record';
import {
  VOICE_PROFILE_CONSENT_STATES,
  refusesGenerationForWithdrawal,
} from '../../../domain/voice/consent-state';
import { CONSENT_RECORD_MIN_RETENTION_DAYS } from '../../../domain/voice/retention';
import { MAX_SHARED_USERS } from '../../../domain/voice/sharing-list';
import {
  MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
  WITHDRAWAL_CLAIM_WINDOW_MS,
} from '../../../domain/voice/withdrawal-quota';
import {
  WITHDRAWAL_EVENT_KINDS,
  applyWithdrawalEvent,
  transitionMutatesAssetVisibility,
  type WithdrawalContext,
} from '../../../domain/voice/withdrawal-machine';
import { IDENTITY_EVIDENCE_KINDS } from '../../../services/voice/ports';
import { WITHDRAWAL_CLAIM_OUTCOMES } from '../../../services/voice/store';

/**
 * Parity guard between `0011_voice_consent.sql` and the rules in `domain/voice/`.
 *
 * The migration is a thin wrapper: the states, the transition table, the windows and the
 * five-year retention floor all exist in two languages, and they are only "the same
 * rules" for as long as something checks. This suite is that check, and — like task 1.1's
 * parity suite — it needs no database, so it runs in the fast loop rather than behind
 * `MUSICSTUDIO_DATABASE_URL`.
 */

const migrations = loadMigrations();
const migration = migrations.find((candidate) => candidate.id === '0011_voice_consent');

if (migration === undefined) throw new Error('missing migration 0011_voice_consent');

const sql: string = migration.sql;

/** Enum member list of a `CREATE TYPE … AS ENUM (…)` block. */
function enumMembers(typeName: string): string[] {
  const pattern = new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`, 'i');
  const body = pattern.exec(sql)?.[1];
  if (body === undefined) throw new Error(`no enum ${typeName} found`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

const T0 = 1_700_000_000_000;

function contextFor(state: (typeof VOICE_PROFILE_CONSENT_STATES)[number]): WithdrawalContext {
  return {
    state,
    stateBeforeWithdrawal: state === '잠정_사용_제한' ? '정상' : null,
    withdrawalReceivedAtMs: state === '정상' ? null : T0,
    provisionalSinceMs: state === '잠정_사용_제한' ? T0 : null,
  };
}

describe('enum parity (design §9.2, §9.3)', () => {
  it('voice_profile_consent_state matches the domain list, in order', () => {
    expect(enumMembers('voice_profile_consent_state')).toEqual([...VOICE_PROFILE_CONSENT_STATES]);
  });

  it('speaker_relationship matches design §9.3', () => {
    expect(enumMembers('speaker_relationship')).toEqual([...SPEAKER_RELATIONSHIPS]);
  });

  it('consent_record_kind matches the domain list', () => {
    expect(enumMembers('consent_record_kind')).toEqual([...CONSENT_RECORD_KINDS]);
  });

  it('withdrawal_claim_outcome matches the store vocabulary', () => {
    expect(enumMembers('withdrawal_claim_outcome')).toEqual([...WITHDRAWAL_CLAIM_OUTCOMES]);
  });

  it('identity_evidence_kind matches the port — the two 26.31 artefacts, no biometrics', () => {
    expect(enumMembers('identity_evidence_kind')).toEqual([...IDENTITY_EVIDENCE_KINDS]);
  });
});

describe('Requirement 26.14 — immutability and the five-year floor', () => {
  it('refuses UPDATE and DELETE in the database, as task 1.1 did for the audit log', () => {
    expect(sql).toContain('CREATE TRIGGER voice_consent_record_no_update');
    expect(sql).toContain('CREATE TRIGGER voice_consent_record_no_delete');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON voice_consent_record FROM PUBLIC');
  });

  it('uses the same retention floor as domain/voice/retention.ts', () => {
    expect(sql).toContain(`p_retain_days integer DEFAULT ${CONSENT_RECORD_MIN_RETENTION_DAYS}`);
    expect(sql).toContain(`IF p_retain_days < ${CONSENT_RECORD_MIN_RETENTION_DAYS} THEN`);
  });

  it('measures retention from profile deletion, so a live profile is never prunable', () => {
    expect(sql).toContain('WHERE p.deleted_at IS NOT NULL');
    expect(sql).toContain('p.deleted_at + make_interval(days => p_retain_days) <= p_now');
  });
});

describe('Requirement 26.13 — the identity basis is a disjunction in SQL too', () => {
  it('accepts either the speaker or an explicit permission', () => {
    expect(sql).toContain('OR (is_speaker OR has_explicit_permission)');
  });

  it('never stores a negative prohibited-use confirmation', () => {
    expect(sql).toContain('CHECK (prohibited_use_confirmation)');
  });

  it('keeps a third-party record contactable (26.14)', () => {
    expect(sql).toContain('voice_consent_third_party_contactable');
    expect(sql).toContain('withdrawal_contact IS NOT NULL');
  });
});

describe('Requirement 26.19 — the share bound', () => {
  it('uses the same maximum as domain/voice/sharing-list.ts', () => {
    expect(sql).toContain(`IF v_count + 1 > ${MAX_SHARED_USERS} THEN`);
  });

  it('keeps the owner out of the list (26.18)', () => {
    expect(sql).toContain('v_owner = NEW.shared_user_id');
  });
});

describe('Requirement 26.35 — the claim cap', () => {
  it('uses the same limit and rolling window as domain/voice/withdrawal-quota.ts', () => {
    const windowDays = WITHDRAWAL_CLAIM_WINDOW_MS / 86_400_000;

    expect(sql).toContain(`p_window_days integer DEFAULT ${windowDays}`);
    expect(sql).toContain(`p_limit integer DEFAULT ${MAX_WITHDRAWAL_CLAIMS_PER_WINDOW}`);
    expect(sql).toContain(
      `voice_withdrawal_claims_in_window(NEW.voice_profile_id, NEW.received_at) >= ${MAX_WITHDRAWAL_CLAIMS_PER_WINDOW}`,
    );
  });

  it('is rolling rather than calendar', () => {
    expect(sql).toContain('received_at > p_now - make_interval(days => p_window_days)');
  });

  it('enforces the cap at write time', () => {
    expect(sql).toContain('CREATE TRIGGER voice_withdrawal_claim_cap');
  });
});

describe('design §9.2 — the transition table agrees with applyWithdrawalEvent', () => {
  it('names every event the domain machine defines', () => {
    for (const kind of WITHDRAWAL_EVENT_KINDS) {
      expect(sql).toContain(kind);
    }
  });

  it('allows exactly the state/event pairs the domain machine allows', () => {
    // `voice_profile_event_applies` is a CASE over the same guard clauses; its arms are
    // read out of the SQL and compared against the machine's own answer.
    //
    // The SQL predicate is deliberately **state-only**. The 14-day window (26.32, 26.34)
    // is a time guard, and the database has no injected clock to read — so it stays in
    // `domain/voice/withdrawal-machine.ts`, and each event is evaluated here at an
    // instant where its own time guard is open. Comparing at one shared instant would
    // conflate "this event does not apply in this state" with "this event is out of time".
    const arms = [...sql.matchAll(/WHEN '([^']+)'\s+THEN p_state (<>|=) '([^']+)'/g)];

    expect(arms.length).toBe(WITHDRAWAL_EVENT_KINDS.length);

    for (const [, event, operator, state] of arms) {
      const kind = event as (typeof WITHDRAWAL_EVENT_KINDS)[number];
      // The lapse needs the window closed; every other event needs it open.
      const atMs = kind === '신원_확인_기한_경과' ? T0 + 14 * 86_400_000 : T0 + 1;

      for (const candidate of VOICE_PROFILE_CONSENT_STATES) {
        const sqlSaysApplies = operator === '=' ? candidate === state : candidate !== state;
        const machineApplies =
          applyWithdrawalEvent(contextFor(candidate), { kind, atMs }).outcome === 'transitioned';

        expect(sqlSaysApplies, `${event} from ${candidate}`).toBe(machineApplies);
      }
    }
  });

  it('sends each event to the same destination state', () => {
    expect(sql).toContain("IF p_event = '동의_철회_접수' THEN");
    expect(sql).toContain("RETURN '잠정_사용_제한';");
    expect(sql).toContain("IF p_event = '신원_확인_성공' THEN");
    expect(sql).toContain("RETURN '사용_중지';");
    // 26.34 restores the recorded prior state rather than assuming 정상.
    expect(sql).toContain(
      "RETURN COALESCE(p_state_before_withdrawal, '정상'::voice_profile_consent_state);",
    );
  });

  it('guards every state write, so no path can write an illegal state', () => {
    expect(sql).toContain('CREATE TRIGGER voice_profile_state_transition');
  });

  it('holds the 14-day context in exactly the states the CHECK constraint allows', () => {
    // `voice_profile_provisional_context` requires `provisional_since` and
    // `state_before_withdrawal` to be non-null **iff** the state is `잠정_사용_제한`. A
    // context the machine produces that broke this would be a row the database refuses,
    // so the two are compared rather than trusted.
    expect(sql).toContain('CONSTRAINT voice_profile_provisional_context CHECK (');
    expect(sql).toContain("(consent_state = '잠정_사용_제한')");

    for (const state of VOICE_PROFILE_CONSENT_STATES) {
      for (const kind of WITHDRAWAL_EVENT_KINDS) {
        const atMs = kind === '신원_확인_기한_경과' ? T0 + 14 * 86_400_000 : T0 + 1;
        const result = applyWithdrawalEvent(contextFor(state), { kind, atMs });
        if (result.outcome !== 'transitioned') continue;

        const next = result.transition.next;
        const carriesContext =
          next.provisionalSinceMs !== null && next.stateBeforeWithdrawal !== null;

        expect(carriesContext, `${kind} from ${state} -> ${next.state}`).toBe(
          next.state === '잠정_사용_제한',
        );
      }
    }
  });
});

describe('Requirements 26.29, 26.30, 26.33 — the two predicates 5.3 will read', () => {
  it('refuses generation in exactly the states the domain predicate refuses', () => {
    const refusing = VOICE_PROFILE_CONSENT_STATES.filter(refusesGenerationForWithdrawal);

    expect(sql).toContain(
      `SELECT p_state IN (${refusing.map((state) => `'${state}'`).join(', ')});`,
    );
  });

  it('26.30 vs 26.33 — unpublishing is due in exactly one state, and it is 사용_중지', () => {
    const unpublishing = VOICE_PROFILE_CONSENT_STATES.filter((state) => {
      const result = applyWithdrawalEvent(contextFor(state === '사용_중지' ? '잠정_사용_제한' : state), {
        kind: state === '사용_중지' ? '신원_확인_성공' : '동의_철회_접수',
        atMs: T0 + 1,
      });
      return (
        result.outcome === 'transitioned' &&
        result.transition.to === state &&
        transitionMutatesAssetVisibility(result.transition)
      );
    });

    expect(unpublishing).toEqual(['사용_중지']);
    expect(sql).toContain("SELECT p_state = '사용_중지';");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION voice_profile_unpublish_due');
  });

  it('26.22 — exposes deletion as its own predicate, since it is 404 rather than 403', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION voice_profile_is_deleted');
    expect(sql).toContain("SELECT p_state = '삭제됨';");
  });
});

describe('the migration set still holds together', () => {
  it('numbers 0011 without a gap or a duplicate', () => {
    const sequences = migrations.map((migration) => Number(migration.id.slice(0, 4)));

    expect(sequences).toEqual(
      Array.from({ length: migrations.length }, (_unused, index) => index + 1),
    );
    expect(migrations.at(-1)?.id).toBe('0011_voice_consent');
  });

  it('creates the three tables Requirement 26 needs', () => {
    for (const table of ['voice_profile', 'voice_profile_share', 'voice_consent_record']) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).toContain('CREATE TABLE voice_withdrawal_claim (');
  });

  it('reports every Requirement 26 invariant under one SQLSTATE class', () => {
    expect(sql).toContain("ERRCODE = 'MS026'");
  });
});
