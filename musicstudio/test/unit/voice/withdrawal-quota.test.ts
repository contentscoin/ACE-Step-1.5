import { describe, expect, it } from 'vitest';

import {
  MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
  WITHDRAWAL_CLAIM_WINDOW_MS,
  claimsInWindow,
  evaluateWithdrawalQuota,
} from '../../../domain/voice/withdrawal-quota';

/**
 * Requirement 26.35 — three withdrawal claims per profile per 30 days, and the fourth
 * is refused with the cap and the next eligible instant.
 *
 * Two things are easy to get wrong here and both are asserted: the window is *rolling*
 * rather than calendar, and "다음 접수 가능 시각" is derived from the **oldest** in-window
 * claim. Using the newest would impose a 30-day ban from the most recent attempt, which
 * is a longer ban than the criterion states.
 */

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

describe('the constants match the criterion', () => {
  it('caps at 3 per 30 days', () => {
    expect(MAX_WITHDRAWAL_CLAIMS_PER_WINDOW).toBe(3);
    expect(WITHDRAWAL_CLAIM_WINDOW_MS).toBe(30 * DAY);
  });
});

describe('Requirement 26.35 — the cap', () => {
  it('admits the first three claims', () => {
    expect(evaluateWithdrawalQuota([], T0)).toEqual({
      outcome: 'within_cap',
      countInWindow: 0,
      limit: 3,
    });
    expect(evaluateWithdrawalQuota([T0 - DAY, T0 - 2 * DAY], T0)).toMatchObject({
      outcome: 'within_cap',
      countInWindow: 2,
    });
  });

  it('refuses the fourth, reporting the cap and the count', () => {
    const decision = evaluateWithdrawalQuota([T0 - DAY, T0 - 2 * DAY, T0 - 3 * DAY], T0);

    expect(decision).toMatchObject({ outcome: 'cap_exceeded', countInWindow: 3, limit: 3 });
  });

  it('derives the next eligible instant from the oldest in-window claim', () => {
    const oldest = T0 - 20 * DAY;
    const decision = evaluateWithdrawalQuota([T0 - DAY, oldest, T0 - 5 * DAY], T0);

    expect(decision).toMatchObject({
      outcome: 'cap_exceeded',
      nextEligibleAtMs: oldest + WITHDRAWAL_CLAIM_WINDOW_MS,
    });
  });

  it('lets a claim through once the oldest one has aged out', () => {
    const claims = [T0 - 29 * DAY, T0 - 10 * DAY, T0 - 5 * DAY];

    expect(evaluateWithdrawalQuota(claims, T0)).toMatchObject({ outcome: 'cap_exceeded' });
    // One day later the 29-day-old claim is outside the window.
    expect(evaluateWithdrawalQuota(claims, T0 + DAY + 1)).toMatchObject({
      outcome: 'within_cap',
      countInWindow: 2,
    });
  });

  it('is rolling rather than calendar', () => {
    // Three claims on one day, then three more the next: a calendar month would admit
    // the fourth. The rolling window does not.
    const sameDay = [T0, T0 + 1_000, T0 + 2_000];

    expect(evaluateWithdrawalQuota(sameDay, T0 + DAY)).toMatchObject({
      outcome: 'cap_exceeded',
      nextEligibleAtMs: T0 + WITHDRAWAL_CLAIM_WINDOW_MS,
    });
  });

  it('counts more than three in-window claims and still frees capacity in order', () => {
    // A store that already holds five (a backfill, or a cap change) must still produce
    // a sane answer: capacity returns when enough of the oldest age out.
    const claims = [T0 - 25 * DAY, T0 - 20 * DAY, T0 - 15 * DAY, T0 - 10 * DAY, T0 - 5 * DAY];
    const decision = evaluateWithdrawalQuota(claims, T0);

    expect(decision).toMatchObject({ outcome: 'cap_exceeded', countInWindow: 5 });
    // The claim whose expiry brings the count down to 2 is the third-newest.
    expect(decision).toMatchObject({
      nextEligibleAtMs: T0 - 15 * DAY + WITHDRAWAL_CLAIM_WINDOW_MS,
    });
  });

  it('honours an explicit limit and window', () => {
    expect(evaluateWithdrawalQuota([T0 - 1_000], T0, 1, 10_000)).toMatchObject({
      outcome: 'cap_exceeded',
      limit: 1,
      nextEligibleAtMs: T0 - 1_000 + 10_000,
    });
  });
});

describe('claimsInWindow', () => {
  it('drops claims at or before the window boundary and sorts oldest first', () => {
    const claims = [T0 - 5 * DAY, T0 - WITHDRAWAL_CLAIM_WINDOW_MS, T0 - 29 * DAY];

    expect(claimsInWindow(claims, T0)).toEqual([T0 - 29 * DAY, T0 - 5 * DAY]);
  });

  it('does not mutate its input', () => {
    const claims = [T0, T0 - DAY];
    claimsInWindow(claims, T0);

    expect(claims).toEqual([T0, T0 - DAY]);
  });
});
