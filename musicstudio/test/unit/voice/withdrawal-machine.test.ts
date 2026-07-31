import { describe, expect, it } from 'vitest';

import {
  INITIAL_CONSENT_STATE,
  VOICE_PROFILE_CONSENT_STATES,
  WITHDRAWAL_REASON_CODES,
  isProfileDeleted,
  isVoiceProfileConsentState,
  refusesGenerationForWithdrawal,
  withdrawalReasonCodeOf,
} from '../../../domain/voice/consent-state';
import {
  ASSET_UNPUBLISH_WINDOW_MS,
  IDENTITY_VERIFICATION_WINDOW_MS,
  VOICE_DATA_ERASURE_WINDOW_MS,
  WITHDRAWAL_INTAKE_WINDOW_MS,
} from '../../../domain/voice/windows';
import {
  WITHDRAWAL_EVENT_KINDS,
  applyWithdrawalEvent,
  effectOf,
  initialWithdrawalContext,
  isVerificationWindowElapsed,
  mutatesAssetVisibility,
  provisionalElapsedMs,
  transitionMutatesAssetVisibility,
  verificationDeadlineMs,
  type WithdrawalContext,
  type WithdrawalEventKind,
  type WithdrawalTransition,
} from '../../../domain/voice/withdrawal-machine';

/**
 * The two-stage withdrawal state machine (design §9.2; Requirements 26.28–26.34).
 *
 * The suite is organised around the one distinction the two stages exist to draw:
 * `잠정_사용_제한` and `사용_중지` refuse generation identically (26.29), and differ
 * only in whether they touch asset visibility (26.30 vs 26.33). "Both directions" is
 * asserted literally — the provisional stage emits no visibility effect *and* the
 * withdrawn stage does.
 */

const T0 = 1_700_000_000_000;

function apply(
  context: WithdrawalContext,
  kind: WithdrawalEventKind,
  atMs: number,
  claimReceivedAtMs?: number,
): WithdrawalTransition {
  const result = applyWithdrawalEvent(context, {
    kind,
    atMs,
    ...(claimReceivedAtMs === undefined ? {} : { claimReceivedAtMs }),
  });
  if (result.outcome !== 'transitioned') {
    throw new Error(`expected ${kind} to apply from ${context.state}, got ${result.reason}`);
  }
  return result.transition;
}

/** `정상` -> `잠정_사용_제한` at `T0`. */
function provisional(): WithdrawalContext {
  return apply(initialWithdrawalContext(), '동의_철회_접수', T0).next;
}

describe('design §9.2 — the state set', () => {
  it('names four states: the three drawn plus the deletion sink', () => {
    expect([...VOICE_PROFILE_CONSENT_STATES]).toEqual([
      '정상',
      '잠정_사용_제한',
      '사용_중지',
      '삭제됨',
    ]);
    expect(INITIAL_CONSENT_STATE).toBe('정상');
    expect(isVoiceProfileConsentState('사용_중지')).toBe(true);
    expect(isVoiceProfileConsentState('withdrawn')).toBe(false);
  });

  it('Requirement 26.29 — exactly the two restricted states refuse generation', () => {
    const refusing = VOICE_PROFILE_CONSENT_STATES.filter(refusesGenerationForWithdrawal);

    expect(refusing).toEqual(['잠정_사용_제한', '사용_중지']);
  });

  it('Requirement 26.22 — the deleted state is 404, so it does not refuse with 403', () => {
    expect(isProfileDeleted('삭제됨')).toBe(true);
    expect(refusesGenerationForWithdrawal('삭제됨')).toBe(false);
    expect(withdrawalReasonCodeOf('삭제됨')).toBeNull();
  });

  it('Requirement 26.29 — the two restricted states carry distinct reason codes', () => {
    expect(withdrawalReasonCodeOf('잠정_사용_제한')).toBe(
      WITHDRAWAL_REASON_CODES.잠정_사용_제한,
    );
    expect(withdrawalReasonCodeOf('사용_중지')).toBe(WITHDRAWAL_REASON_CODES.사용_중지);
    expect(withdrawalReasonCodeOf('잠정_사용_제한')).not.toBe(
      withdrawalReasonCodeOf('사용_중지'),
    );
    expect(withdrawalReasonCodeOf('정상')).toBeNull();
  });
});

describe('Requirement 26.28 — 정상 -> 잠정_사용_제한 within 24 hours of intake', () => {
  it('restricts the profile and starts the 14-day verification clock', () => {
    const transition = apply(initialWithdrawalContext(), '동의_철회_접수', T0);

    expect(transition.from).toBe('정상');
    expect(transition.to).toBe('잠정_사용_제한');
    expect(transition.next.provisionalSinceMs).toBe(T0);
    expect(transition.next.stateBeforeWithdrawal).toBe('정상');
    expect(effectOf(transition, 'require_identity_verification')?.dueAtMs).toBe(
      T0 + IDENTITY_VERIFICATION_WINDOW_MS,
    );
  });

  it('notifies the owner, which is where 26.36 objection guidance rides', () => {
    expect(effectOf(apply(initialWithdrawalContext(), '동의_철회_접수', T0), 'notify_owner'))
      .toBeDefined();
  });

  it('measures the 24-hour budget from intake, not from when the queue ran', () => {
    const onTime = apply(
      initialWithdrawalContext(),
      '동의_철회_접수',
      T0 + WITHDRAWAL_INTAKE_WINDOW_MS,
      T0,
    );
    expect(onTime.withinIntakeWindow).toBe(true);
    expect(onTime.next.withdrawalReceivedAtMs).toBe(T0);

    const late = apply(
      initialWithdrawalContext(),
      '동의_철회_접수',
      T0 + WITHDRAWAL_INTAKE_WINDOW_MS + 1,
      T0,
    );
    expect(late.withinIntakeWindow).toBe(false);
  });

  it('still restricts the profile when the transition is late — reported, not refused', () => {
    // A slow queue must not be able to defeat a withdrawal.
    const late = apply(initialWithdrawalContext(), '동의_철회_접수', T0 + 10 * 86_400_000, T0);

    expect(late.to).toBe('잠정_사용_제한');
    expect(late.withinIntakeWindow).toBe(false);
  });

  it('refuses a second claim against an already restricted profile', () => {
    const result = applyWithdrawalEvent(provisional(), { kind: '동의_철회_접수', atMs: T0 + 1 });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'state_not_applicable',
      from: '잠정_사용_제한',
      event: '동의_철회_접수',
    });
  });
});

describe('Requirements 26.30 vs 26.33 — the one difference between the two stages', () => {
  it('26.30 — the provisional transition emits no visibility change', () => {
    const transition = apply(initialWithdrawalContext(), '동의_철회_접수', T0);

    expect(transitionMutatesAssetVisibility(transition)).toBe(false);
    expect(transition.effects.map((effect) => effect.kind)).not.toContain(
      'unpublish_generated_assets',
    );
    // Stated as an obligation, so the *absence* of a change is part of the record.
    expect(effectOf(transition, 'preserve_asset_visibility')).toEqual({
      kind: 'preserve_asset_visibility',
      dueAtMs: null,
    });
  });

  it('26.33 — the 사용_중지 transition turns public assets private within 24 hours', () => {
    const verified = apply(provisional(), '신원_확인_성공', T0 + 86_400_000);

    expect(verified.to).toBe('사용_중지');
    expect(transitionMutatesAssetVisibility(verified)).toBe(true);
    expect(effectOf(verified, 'unpublish_generated_assets')?.dueAtMs).toBe(
      T0 + 86_400_000 + ASSET_UNPUBLISH_WINDOW_MS,
    );
  });

  it('no transition *into* 잠정_사용_제한 may change visibility, over every reachable path', () => {
    // Exhaustive rather than hand-picked: every state crossed with every event.
    for (const state of VOICE_PROFILE_CONSENT_STATES) {
      for (const kind of WITHDRAWAL_EVENT_KINDS) {
        const context: WithdrawalContext = {
          state,
          stateBeforeWithdrawal: state === '잠정_사용_제한' ? '정상' : null,
          withdrawalReceivedAtMs: state === '정상' ? null : T0,
          provisionalSinceMs: state === '잠정_사용_제한' ? T0 : null,
        };
        const result = applyWithdrawalEvent(context, {
          kind,
          atMs: T0 + IDENTITY_VERIFICATION_WINDOW_MS,
        });
        if (result.outcome !== 'transitioned') continue;

        if (result.transition.to === '잠정_사용_제한') {
          expect(transitionMutatesAssetVisibility(result.transition)).toBe(false);
        }
        if (transitionMutatesAssetVisibility(result.transition)) {
          expect(result.transition.to).toBe('사용_중지');
        }
      }
    }
  });

  it('identifies exactly one effect kind as a visibility mutation', () => {
    expect(mutatesAssetVisibility({ kind: 'unpublish_generated_assets', dueAtMs: 0 })).toBe(true);
    expect(mutatesAssetVisibility({ kind: 'preserve_asset_visibility', dueAtMs: null })).toBe(
      false,
    );
    expect(mutatesAssetVisibility({ kind: 'erase_voice_data', dueAtMs: 0 })).toBe(false);
  });
});

describe('Requirement 26.32 — 잠정_사용_제한 -> 사용_중지 on verification within 14 days', () => {
  it('erases the 26.21 data set within 24 hours of the transition', () => {
    const verified = apply(provisional(), '신원_확인_성공', T0 + 3_600_000);

    expect(effectOf(verified, 'erase_voice_data')?.dueAtMs).toBe(
      T0 + 3_600_000 + VOICE_DATA_ERASURE_WINDOW_MS,
    );
  });

  it('drops the 14-day context, since the claim has been decided', () => {
    // A surviving `provisionalSinceMs` would make `verificationDeadlineMs` report a
    // deadline for a settled claim, and `0011_voice_consent.sql` refuses the row outright.
    const verified = apply(provisional(), '신원_확인_성공', T0 + 1);

    expect(verified.next.provisionalSinceMs).toBeNull();
    expect(verified.next.stateBeforeWithdrawal).toBeNull();
    expect(verificationDeadlineMs(verified.next)).toBeNull();
    // The intake instant is kept: it is the audit trail of when the claim arrived.
    expect(verified.next.withdrawalReceivedAtMs).toBe(T0);
  });

  it('accepts verification on the last instant before the window closes', () => {
    const verified = apply(provisional(), '신원_확인_성공', T0 + IDENTITY_VERIFICATION_WINDOW_MS - 1);

    expect(verified.to).toBe('사용_중지');
  });

  it('refuses verification once the 14-day window has closed', () => {
    const result = applyWithdrawalEvent(provisional(), {
      kind: '신원_확인_성공',
      atMs: T0 + IDENTITY_VERIFICATION_WINDOW_MS,
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'verification_window_elapsed',
      from: '잠정_사용_제한',
      event: '신원_확인_성공',
    });
  });

  it('refuses verification from 정상 — there is no claim to verify', () => {
    const result = applyWithdrawalEvent(initialWithdrawalContext(), {
      kind: '신원_확인_성공',
      atMs: T0,
    });

    expect(result).toMatchObject({ outcome: 'refused', reason: 'state_not_applicable' });
  });

  it('exposes the deadline and the elapsed time from the same clock origin', () => {
    const context = provisional();

    expect(verificationDeadlineMs(context)).toBe(T0 + IDENTITY_VERIFICATION_WINDOW_MS);
    expect(provisionalElapsedMs(context, T0 + 5_000)).toBe(5_000);
    expect(provisionalElapsedMs(initialWithdrawalContext(), T0)).toBeNull();
    expect(verificationDeadlineMs(initialWithdrawalContext())).toBeNull();
  });

  it('closes the window at exactly 14 days, not before', () => {
    const context = provisional();

    expect(isVerificationWindowElapsed(context, T0 + IDENTITY_VERIFICATION_WINDOW_MS - 1)).toBe(
      false,
    );
    expect(isVerificationWindowElapsed(context, T0 + IDENTITY_VERIFICATION_WINDOW_MS)).toBe(true);
  });
});

describe('Requirement 26.34 — verification failure or lapse restores the prior state', () => {
  it('restores immediately on a verification failure', () => {
    const reverted = apply(provisional(), '신원_확인_실패', T0 + 3_600_000);

    expect(reverted.to).toBe('정상');
    expect(reverted.next.provisionalSinceMs).toBeNull();
    expect(reverted.next.stateBeforeWithdrawal).toBeNull();
  });

  it('notifies both the owner and the claimant', () => {
    const reverted = apply(provisional(), '신원_확인_실패', T0 + 3_600_000);
    const kinds = reverted.effects.map((effect) => effect.kind);

    expect(kinds).toContain('notify_owner');
    expect(kinds).toContain('notify_claimant');
  });

  it('has nothing to undo, because 26.30 held throughout', () => {
    const reverted = apply(provisional(), '신원_확인_실패', T0 + 3_600_000);

    expect(transitionMutatesAssetVisibility(reverted)).toBe(false);
    expect(effectOf(reverted, 'preserve_asset_visibility')).toBeDefined();
  });

  it('restores on the 14-day lapse', () => {
    const reverted = apply(provisional(), '신원_확인_기한_경과', T0 + IDENTITY_VERIFICATION_WINDOW_MS);

    expect(reverted.to).toBe('정상');
  });

  it('refuses to expire the claim before the window closes', () => {
    const result = applyWithdrawalEvent(provisional(), {
      kind: '신원_확인_기한_경과',
      atMs: T0 + IDENTITY_VERIFICATION_WINDOW_MS - 1,
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'verification_window_open',
      from: '잠정_사용_제한',
      event: '신원_확인_기한_경과',
    });
  });

  it('restores to the recorded prior state rather than assuming 정상', () => {
    // A revert must not promote a profile that was restricted for another reason.
    const context: WithdrawalContext = {
      state: '잠정_사용_제한',
      stateBeforeWithdrawal: '사용_중지',
      withdrawalReceivedAtMs: T0,
      provisionalSinceMs: T0,
    };

    expect(apply(context, '신원_확인_실패', T0 + 1).to).toBe('사용_중지');
  });
});

describe('design §9.2 / Requirements 26.21, 26.23 — deletion', () => {
  it('leaves the machine as 삭제됨 once the 사용_중지 erasure completes', () => {
    const withdrawn = apply(provisional(), '신원_확인_성공', T0 + 1).next;
    const deleted = apply(withdrawn, '데이터_삭제_완료', T0 + 2);

    expect(deleted.to).toBe('삭제됨');
    // 26.33 already unpublished; erasure destroys the profile's data, not its output.
    expect(effectOf(deleted, 'preserve_generated_assets')).toBeDefined();
    expect(transitionMutatesAssetVisibility(deleted)).toBe(false);
  });

  it('refuses erasure completion outside 사용_중지', () => {
    const result = applyWithdrawalEvent(provisional(), { kind: '데이터_삭제_완료', atMs: T0 + 1 });

    expect(result).toMatchObject({ outcome: 'refused', reason: 'state_not_applicable' });
  });

  it('26.21/26.23 — owner deletion erases data and preserves generated assets', () => {
    const deleted = apply(initialWithdrawalContext(), '소유자_삭제_요청', T0);

    expect(deleted.to).toBe('삭제됨');
    expect(effectOf(deleted, 'erase_voice_data')?.dueAtMs).toBe(T0 + VOICE_DATA_ERASURE_WINDOW_MS);
    expect(effectOf(deleted, 'preserve_generated_assets')).toBeDefined();
    // The opposite of 26.33, and reached by a different event on purpose: deleting a
    // profile is not a retraction of consent.
    expect(transitionMutatesAssetVisibility(deleted)).toBe(false);
  });

  it('26.21 — the owner may delete from a restricted state too', () => {
    expect(apply(provisional(), '소유자_삭제_요청', T0 + 1).to).toBe('삭제됨');
  });

  it('refuses a second deletion', () => {
    const deleted = apply(initialWithdrawalContext(), '소유자_삭제_요청', T0).next;
    const result = applyWithdrawalEvent(deleted, { kind: '소유자_삭제_요청', atMs: T0 + 1 });

    expect(result).toMatchObject({ outcome: 'refused', reason: 'state_not_applicable' });
  });
});

describe('the machine is total', () => {
  it('answers every state/event pair without throwing', () => {
    for (const state of VOICE_PROFILE_CONSENT_STATES) {
      for (const kind of WITHDRAWAL_EVENT_KINDS) {
        const context: WithdrawalContext = {
          state,
          stateBeforeWithdrawal: null,
          withdrawalReceivedAtMs: null,
          provisionalSinceMs: state === '잠정_사용_제한' ? T0 : null,
        };

        expect(() =>
          applyWithdrawalEvent(context, { kind, atMs: T0 + IDENTITY_VERIFICATION_WINDOW_MS }),
        ).not.toThrow();
      }
    }
  });
});
