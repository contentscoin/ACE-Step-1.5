import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  VOICE_PROFILE_CONSENT_STATES,
  refusesGenerationForWithdrawal,
  withdrawalReasonCodeOf,
} from '../../domain/voice/consent-state';
import {
  CONSENT_RECORD_MIN_RETENTION_MS,
  isConsentRecordPrunable,
  retentionFloorMs,
} from '../../domain/voice/retention';
import {
  MAX_SHARED_USERS,
  isUsePermitted,
  validateShareList,
} from '../../domain/voice/sharing-list';
import { IDENTITY_VERIFICATION_WINDOW_MS } from '../../domain/voice/windows';
import {
  MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
  WITHDRAWAL_CLAIM_WINDOW_MS,
  claimsInWindow,
  evaluateWithdrawalQuota,
} from '../../domain/voice/withdrawal-quota';
import {
  WITHDRAWAL_EVENT_KINDS,
  applyWithdrawalEvent,
  initialWithdrawalContext,
  transitionMutatesAssetVisibility,
  type WithdrawalContext,
  type WithdrawalEventKind,
} from '../../domain/voice/withdrawal-machine';

/**
 * Local invariants of the consent withdrawal machinery (task 6.2). These are *not* the
 * numbered correctness properties of design §10, which cover parsers, mixdown, loudness
 * and licensing; they pin the Requirement 26 rules whose correctness is a claim about
 * **all** event orderings and **all** instants rather than about a handful of examples.
 *
 * The first property is the one that matters most. Requirements 26.30 and 26.33 differ
 * in exactly one respect — whether asset visibility changes — and three separate events
 * can move a profile out of `잠정_사용_제한`. So "a provisional restriction never
 * unpublishes anything" has to hold for every reachable sequence, including a lapse
 * racing a late verification racing an owner deletion, not just for the happy path.
 *
 * Time is a generated parameter throughout, never a sleep.
 */

const NUM_RUNS = 200;

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

const eventArbitrary: fc.Arbitrary<WithdrawalEventKind> = fc.constantFrom(
  ...WITHDRAWAL_EVENT_KINDS,
);

/** An event plus how far the clock moved before it was applied. */
const stepArbitrary = fc.record({
  kind: eventArbitrary,
  gapMs: fc.integer({ min: 0, max: 20 * DAY }),
});

const sequenceArbitrary = fc.array(stepArbitrary, { minLength: 1, maxLength: 12 });

interface Replay {
  readonly context: WithdrawalContext;
  readonly unpublishedFrom: readonly string[];
  readonly statesVisited: readonly string[];
}

/** Fold a generated sequence through the machine, recording what it did. */
function replay(steps: readonly { kind: WithdrawalEventKind; gapMs: number }[]): Replay {
  let context = initialWithdrawalContext();
  let atMs = T0;
  const unpublishedFrom: string[] = [];
  const statesVisited: string[] = [context.state];

  for (const step of steps) {
    atMs += step.gapMs;
    const result = applyWithdrawalEvent(context, { kind: step.kind, atMs });
    if (result.outcome !== 'transitioned') continue;

    if (transitionMutatesAssetVisibility(result.transition)) {
      unpublishedFrom.push(result.transition.from);
    }
    context = result.transition.next;
    statesVisited.push(context.state);
  }

  return { context, unpublishedFrom, statesVisited };
}

describe('Requirements 26.30 and 26.33 — visibility changes only on a completed withdrawal', () => {
  /**
   * For every reachable event sequence, an asset visibility change is emitted only by a
   * transition **into** `사용_중지`, and never by one into `잠정_사용_제한`. This is the
   * machine-checkable form of "a provisional restriction does not touch what the public
   * can see, and a verified withdrawal does".
   *
   * **Validates: Requirements 26.30, 26.33**
   */
  it('never unpublishes on the way into the provisional stage', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (steps) => {
        let context = initialWithdrawalContext();
        let atMs = T0;

        for (const step of steps) {
          atMs += step.gapMs;
          const result = applyWithdrawalEvent(context, { kind: step.kind, atMs });
          if (result.outcome !== 'transitioned') continue;

          const { transition } = result;
          if (transition.to === '잠정_사용_제한') {
            expect(transitionMutatesAssetVisibility(transition)).toBe(false);
          }
          if (transitionMutatesAssetVisibility(transition)) {
            // The only transition that may change visibility is the one 26.33 describes.
            expect(transition.to).toBe('사용_중지');
            expect(transition.event).toBe('신원_확인_성공');
          }
          context = transition.next;
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * A sequence that never reaches `사용_중지` never unpublishes anything. Stated
   * separately from the transition-level property because it is the claim an owner
   * actually cares about: an unverified claim, however many times it is filed, reverted
   * and refiled, costs them nothing that has to be undone.
   *
   * **Validates: Requirement 26.30**
   */
  it('leaves assets alone entirely unless the withdrawal completed', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (steps) => {
        const result = replay(steps);

        if (!result.statesVisited.includes('사용_중지')) {
          expect(result.unpublishedFrom).toEqual([]);
        }
        for (const from of result.unpublishedFrom) {
          expect(from).toBe('잠정_사용_제한');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('the state machine is total and never leaves a stale window behind', () => {
  /**
   * Every event applies or is refused, from every reachable context, and a transition
   * always lands on a declared state. Refusals carry the state they were refused from,
   * so no caller has to guess.
   *
   * **Validates: Requirements 26.28, 26.32, 26.34**
   */
  it('answers every sequence without throwing, and only with declared states', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (steps) => {
        const result = replay(steps);

        for (const state of result.statesVisited) {
          expect(VOICE_PROFILE_CONSENT_STATES).toContain(state);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * The 14-day clock origin exists exactly when the profile is in `잠정_사용_제한`. A
   * restore that left `provisionalSinceMs` set would make the next claim's window start
   * in the past; a provisional state without it would make the window never close.
   *
   * **Validates: Requirements 26.31, 26.34**
   */
  it('carries the provisional clock origin in exactly the provisional state', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (steps) => {
        const { context } = replay(steps);

        expect(context.provisionalSinceMs !== null).toBe(context.state === '잠정_사용_제한');
        if (context.state === '잠정_사용_제한') {
          expect(context.stateBeforeWithdrawal).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * `삭제됨` is terminal: once reached, no event moves the profile anywhere else. 26.22's
   * 404 would otherwise be temporary, and a deleted profile could come back into use.
   *
   * **Validates: Requirement 26.22**
   */
  it('treats deletion as terminal', () => {
    fc.assert(
      fc.property(sequenceArbitrary, sequenceArbitrary, (before, after) => {
        const reached = replay(before);
        if (reached.context.state !== '삭제됨') return;

        let context = reached.context;
        let atMs = T0 + 100 * DAY;
        for (const step of after) {
          atMs += step.gapMs;
          const result = applyWithdrawalEvent(context, { kind: step.kind, atMs });
          expect(result.outcome).toBe('refused');
          if (result.outcome === 'transitioned') context = result.transition.next;
        }
        expect(context.state).toBe('삭제됨');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * Verification succeeds only strictly inside the 14-day window, and the lapse applies
   * only outside it. The two are complementary at every instant, so there is never a
   * moment where neither event can move an open claim forward.
   *
   * **Validates: Requirements 26.32, 26.34**
   */
  it('splits the 14-day window between verification and lapse with no gap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 * DAY }), (elapsedMs) => {
        const provisional = applyWithdrawalEvent(initialWithdrawalContext(), {
          kind: '동의_철회_접수',
          atMs: T0,
        });
        if (provisional.outcome !== 'transitioned') throw new Error('intake must apply');
        const context = provisional.transition.next;
        const atMs = T0 + elapsedMs;

        const verified =
          applyWithdrawalEvent(context, { kind: '신원_확인_성공', atMs }).outcome ===
          'transitioned';
        const lapsed =
          applyWithdrawalEvent(context, { kind: '신원_확인_기한_경과', atMs }).outcome ===
          'transitioned';

        expect(verified).toBe(elapsedMs < IDENTITY_VERIFICATION_WINDOW_MS);
        expect(lapsed).toBe(elapsedMs >= IDENTITY_VERIFICATION_WINDOW_MS);
        // Exactly one of the two is available at any instant.
        expect(verified !== lapsed).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Requirement 26.29 — refusal and the reason code agree everywhere', () => {
  /**
   * A state refuses generation if and only if it carries a withdrawal reason code. The
   * 403 body and the refusal decision are read by different call sites, and a state that
   * refused without a code — or carried one without refusing — would make the two
   * disagree.
   *
   * **Validates: Requirement 26.29**
   */
  it('pairs the refusal with a reason code, in both directions', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VOICE_PROFILE_CONSENT_STATES), (state) => {
        expect(refusesGenerationForWithdrawal(state)).toBe(withdrawalReasonCodeOf(state) !== null);
      }),
      { numRuns: VOICE_PROFILE_CONSENT_STATES.length },
    );
  });

  /**
   * Whatever the sequence, the resulting state's refusal decision is a function of that
   * state alone — so a caller reading the stored state reaches the same answer the
   * machine did, with no history to replay.
   *
   * **Validates: Requirement 26.29**
   */
  it('decides refusal from the stored state alone', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (steps) => {
        const { context } = replay(steps);
        const refuses = refusesGenerationForWithdrawal(context.state);

        expect(refuses).toBe(context.state === '잠정_사용_제한' || context.state === '사용_중지');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Requirement 26.35 — the rolling claim cap', () => {
  const instants = fc.array(fc.integer({ min: 0, max: 60 * DAY }), { maxLength: 12 });

  /**
   * The decision is exactly "fewer than three claims inside the window", for any claim
   * history and any instant. Stated as an equivalence rather than as examples because the
   * failure mode is an off-by-one at the boundary, which examples tend to miss.
   *
   * **Validates: Requirement 26.35**
   */
  it('admits a claim if and only if fewer than three are in the window', () => {
    fc.assert(
      fc.property(instants, fc.integer({ min: 0, max: 90 * DAY }), (offsets, nowOffset) => {
        const claims = offsets.map((offset) => T0 + offset);
        const nowMs = T0 + nowOffset;
        const decision = evaluateWithdrawalQuota(claims, nowMs);
        const inWindow = claimsInWindow(claims, nowMs);

        expect(decision.outcome === 'within_cap').toBe(
          inWindow.length < MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
        );
        expect(decision.countInWindow).toBe(inWindow.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * The advertised `nextEligibleAtMs` is honest: at that instant the cap admits a claim
   * again. A next-eligible time that still refused would send the claimant away twice.
   *
   * **Validates: Requirement 26.35**
   */
  it('admits a claim at the instant it advertised', () => {
    fc.assert(
      fc.property(instants, fc.integer({ min: 0, max: 90 * DAY }), (offsets, nowOffset) => {
        const claims = offsets.map((offset) => T0 + offset);
        const nowMs = T0 + nowOffset;
        const decision = evaluateWithdrawalQuota(claims, nowMs);
        if (decision.outcome !== 'cap_exceeded') return;

        expect(decision.nextEligibleAtMs).toBeGreaterThan(nowMs);
        expect(evaluateWithdrawalQuota(claims, decision.nextEligibleAtMs).outcome).toBe(
          'within_cap',
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * The window is rolling: a claim exactly 30 days old is outside it, and nothing older
   * is ever counted.
   *
   * **Validates: Requirement 26.35**
   */
  it('counts only claims strictly inside the 30-day window', () => {
    fc.assert(
      fc.property(instants, fc.integer({ min: 0, max: 90 * DAY }), (offsets, nowOffset) => {
        const claims = offsets.map((offset) => T0 + offset);
        const nowMs = T0 + nowOffset;

        for (const instant of claimsInWindow(claims, nowMs)) {
          expect(instant).toBeGreaterThan(nowMs - WITHDRAWAL_CLAIM_WINDOW_MS);
          expect(instant).toBeLessThanOrEqual(Math.max(nowMs, instant));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Requirement 26.14 — the five-year retention floor', () => {
  /**
   * A record is prunable if and only if the profile is deleted and the full window has
   * passed. There is no instant, and no deletion time, at which a live profile's record
   * becomes prunable.
   *
   * **Validates: Requirement 26.14**
   */
  it('never prunes a record before deletion plus five years', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 * 365 * DAY }),
        fc.integer({ min: 0, max: 20 * 365 * DAY }),
        (deletionOffset, nowOffset) => {
          const profileDeletedAtMs = T0 + deletionOffset;
          const nowMs = T0 + nowOffset;

          expect(isConsentRecordPrunable({ profileDeletedAtMs }, nowMs)).toBe(
            nowMs >= profileDeletedAtMs + CONSENT_RECORD_MIN_RETENTION_MS,
          );
          // A live profile's record is never prunable, whatever the instant.
          expect(isConsentRecordPrunable({ profileDeletedAtMs: null }, nowMs)).toBe(false);
          expect(retentionFloorMs({ profileDeletedAtMs: null })).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Requirements 26.18–26.20 — the share list', () => {
  const userId = fc.string({ minLength: 1, maxLength: 12 }).filter((id) => id.trim().length > 0);

  /**
   * A valid share list holds between 1 and 50 distinct users, never the owner, and never
   * a duplicate — whatever was proposed. Duplicates are the interesting case: the bound
   * has to measure distinct users, or the same id repeated 50 times would consume the
   * whole allowance.
   *
   * **Validates: Requirement 26.19**
   */
  it('normalises to 1..50 distinct non-owner users, or reports why not', () => {
    fc.assert(
      fc.property(userId, fc.array(userId, { maxLength: 60 }), (ownerId, proposed) => {
        const validation = validateShareList(ownerId, proposed);
        const distinct = new Set(proposed.map((id) => id.trim()).filter((id) => id.length > 0));

        if (validation.outcome === 'valid') {
          expect(validation.sharedUserIds.length).toBeGreaterThanOrEqual(1);
          expect(validation.sharedUserIds.length).toBeLessThanOrEqual(MAX_SHARED_USERS);
          expect(new Set(validation.sharedUserIds).size).toBe(validation.sharedUserIds.length);
          expect(validation.sharedUserIds).not.toContain(ownerId);
          return;
        }

        expect(
          distinct.has(ownerId) || distinct.size === 0 || distinct.size > MAX_SHARED_USERS,
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * The owner is permitted regardless of the list, and a user is permitted if and only if
   * they are the owner or on it. 26.18's grant cannot be revoked by a list edit.
   *
   * **Validates: Requirements 26.18, 26.20**
   */
  it('permits the owner unconditionally and nobody else off the list', () => {
    fc.assert(
      fc.property(userId, fc.array(userId, { maxLength: 20 }), userId, (ownerId, shared, who) => {
        const access = { ownerId, sharedUserIds: shared };

        expect(isUsePermitted(access, ownerId)).toBe(true);
        expect(isUsePermitted(access, who)).toBe(who === ownerId || shared.includes(who));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
