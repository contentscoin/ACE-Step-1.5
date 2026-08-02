/**
 * Requirement 26.35 — at most three withdrawal claims per Voice_Profile per 30 days;
 * the fourth is refused with the cap and the next eligible instant.
 *
 * This cap is the other half of the denial-of-service defence that motivates the
 * two-stage machine. `잠정_사용_제한` limits what one claim can cost the owner; this
 * limits how often the cost can be imposed at all.
 *
 * The window is **rolling**, not a calendar month: with a calendar window a claimant
 * could file three claims on the 31st and three more the next day. Eligibility is
 * therefore derived from the oldest claim still inside the window, which is what makes
 * "다음 접수 가능 시각" a computable instant rather than an estimate.
 */

import {
  MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
  WITHDRAWAL_CLAIM_WINDOW_MS,
} from './windows';

export { MAX_WITHDRAWAL_CLAIMS_PER_WINDOW, WITHDRAWAL_CLAIM_WINDOW_MS };

export type WithdrawalQuotaDecision =
  | { readonly outcome: 'within_cap'; readonly countInWindow: number; readonly limit: number }
  | {
      readonly outcome: 'cap_exceeded';
      readonly countInWindow: number;
      readonly limit: number;
      /** Requirement 26.35 — 다음 접수 가능 시각. */
      readonly nextEligibleAtMs: number;
    };

/** Claim instants inside the rolling window ending at `nowMs`, oldest first. */
export function claimsInWindow(
  claimInstantsMs: readonly number[],
  nowMs: number,
  windowMs: number = WITHDRAWAL_CLAIM_WINDOW_MS,
): readonly number[] {
  const from = nowMs - windowMs;
  return [...claimInstantsMs].filter((at) => at > from).sort((left, right) => left - right);
}

/**
 * Requirement 26.35 — may another claim be accepted at `nowMs`?
 *
 * `nextEligibleAtMs` is the moment the oldest in-window claim leaves the window, at
 * which point the count drops back below the cap. Note that this is the *oldest*
 * claim, not the newest: a caller who used the newest would tell the claimant to come
 * back 30 days after their most recent attempt, which is a longer ban than the
 * criterion states.
 */
export function evaluateWithdrawalQuota(
  claimInstantsMs: readonly number[],
  nowMs: number,
  limit: number = MAX_WITHDRAWAL_CLAIMS_PER_WINDOW,
  windowMs: number = WITHDRAWAL_CLAIM_WINDOW_MS,
): WithdrawalQuotaDecision {
  const inWindow = claimsInWindow(claimInstantsMs, nowMs, windowMs);

  if (inWindow.length < limit) {
    return { outcome: 'within_cap', countInWindow: inWindow.length, limit };
  }

  // Once the count is at or above the cap, capacity returns when enough of the
  // oldest claims age out. Index `length - limit` is the claim whose expiry brings
  // the in-window count down to `limit - 1`.
  const releasing = inWindow[inWindow.length - limit] as number;

  return {
    outcome: 'cap_exceeded',
    countInWindow: inWindow.length,
    limit,
    nextEligibleAtMs: releasing + windowMs,
  };
}
