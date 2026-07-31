/**
 * Review state of a public Audio_Asset (Requirements 16.8, 16.9).
 *
 * Stated once here as pure functions; `db/migrations/0009_content_report.sql` is a
 * thin wrapper over the same three things — the state list, the transition table,
 * and the discovery-feed predicate. `test/unit/schema-parity.test.ts` fails if the
 * two drift.
 *
 * ```
 *   none ──report──► under_review ──clear───► cleared ──report──► under_review
 *                          │
 *                          └──withhold──► withheld ──report──► withheld
 * ```
 *
 * `withheld` rather than "deleted": an operator upholding a report removes the asset
 * from the feed, which is not the same act as the owner's soft delete (Requirement
 * 11.8). Keeping them separate means neither one has to reason about the other.
 */

export const ASSET_REVIEW_STATES = ['none', 'under_review', 'cleared', 'withheld'] as const;

export type AssetReviewState = (typeof ASSET_REVIEW_STATES)[number];

export const INITIAL_REVIEW_STATE: AssetReviewState = 'none';

/** How an operator can close a review. */
export const REVIEW_RESOLUTIONS = ['cleared', 'withheld'] as const;

export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];

export function isAssetReviewState(value: unknown): value is AssetReviewState {
  return typeof value === 'string' && (ASSET_REVIEW_STATES as readonly string[]).includes(value);
}

/**
 * Requirement 16.8 — accepting a report marks the asset under review.
 *
 * Total and idempotent: a second report on an asset already under review leaves it
 * under review, and a report on a `withheld` asset does not resurrect it into the
 * queue. Both matter because reports arrive from visitors, in any number, in any
 * order.
 */
export function reviewStateAfterReport(current: AssetReviewState): AssetReviewState {
  return current === 'withheld' ? 'withheld' : 'under_review';
}

/** Closing a review. Only an asset under review has a review to close. */
export function reviewStateAfterResolution(
  current: AssetReviewState,
  resolution: ReviewResolution,
): AssetReviewState {
  return current === 'under_review' ? resolution : current;
}

export function canResolveReview(current: AssetReviewState): boolean {
  return current === 'under_review';
}

/**
 * Requirement 16.9 — the discovery-feed predicate.
 *
 * Sharing_Service (task 5.3) owns the feed query; this is the rule it applies. An
 * asset under review is excluded while the review is open, and a withheld asset
 * stays excluded. `none` and `cleared` are discoverable as far as *review* is
 * concerned — publication and soft-delete are separate conditions that 5.3 ANDs in.
 */
export function isExcludedFromDiscoveryFeed(state: AssetReviewState): boolean {
  return state === 'under_review' || state === 'withheld';
}

/** States a discovery-feed query may include, for the SQL view to mirror. */
export const DISCOVERABLE_REVIEW_STATES: readonly AssetReviewState[] = ASSET_REVIEW_STATES.filter(
  (state) => !isExcludedFromDiscoveryFeed(state),
);
