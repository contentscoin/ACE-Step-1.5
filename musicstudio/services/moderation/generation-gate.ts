/**
 * The ordering guarantee behind "credits are not charged" (Requirements 16.2, 16.11).
 *
 * Design §9.1 puts the policy check before the engine call, and by extension before
 * anything that costs money. That ordering is easy to state and easy to lose: any
 * future caller could debit first and moderate second, and no type would object.
 *
 * So the ordering is a function rather than a convention. Everything that may cost
 * credits goes inside `proceed`, and `proceed` is unreachable unless the decision is
 * approved. A block returns without ever having had a callable that could charge.
 *
 * Credit_Service is task 1.4; this gate deliberately knows nothing about it. The
 * test asserts the guarantee by passing a `proceed` that debits a stand-in balance
 * which throws on any debit: it is never invoked on the blocked path, and the
 * balance is observably unchanged.
 */

import type { ApprovedModeration, BlockedModeration, ModerationDecision } from './decision';

export type GatedOutcome<T> =
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  | { readonly kind: 'proceed'; readonly value: T };

/**
 * Runs `decide`, and only on approval runs `proceed`.
 *
 * `decide` is a thunk rather than an already-computed decision so that a caller
 * cannot accidentally moderate *after* doing the expensive work and then pass the
 * result in.
 */
export async function withModerationGate<T>(
  decide: () => ModerationDecision,
  proceed: (approved: ApprovedModeration) => Promise<T>,
): Promise<GatedOutcome<T>> {
  const decision = decide();
  if (decision.outcome === 'blocked') {
    return { kind: 'blocked', decision };
  }

  return { kind: 'proceed', value: await proceed(decision) };
}
