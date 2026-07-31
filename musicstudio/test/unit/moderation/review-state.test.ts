import { describe, expect, it } from 'vitest';

import {
  ASSET_REVIEW_STATES,
  DISCOVERABLE_REVIEW_STATES,
  canResolveReview,
  isExcludedFromDiscoveryFeed,
  reviewStateAfterReport,
  reviewStateAfterResolution,
  type AssetReviewState,
} from '../../../domain/moderation/review-state';

/**
 * Review state machine and discovery-feed predicate (Requirements 16.8, 16.9).
 *
 * Pure rules, wrapped by `db/migrations/0009_content_report.sql`.
 */

describe('report transition (Requirement 16.8)', () => {
  it('marks an unreported asset under review', () => {
    expect(reviewStateAfterReport('none')).toBe('under_review');
  });

  it('is idempotent for repeated reports', () => {
    // Reports arrive from visitors in any number; the second must not change the
    // state or reopen anything.
    expect(reviewStateAfterReport('under_review')).toBe('under_review');
  });

  it('re-opens review on a previously cleared asset', () => {
    expect(reviewStateAfterReport('cleared')).toBe('under_review');
  });

  it('does not resurrect a withheld asset into the queue', () => {
    expect(reviewStateAfterReport('withheld')).toBe('withheld');
  });

  it('is total over every state', () => {
    for (const state of ASSET_REVIEW_STATES) {
      expect(ASSET_REVIEW_STATES).toContain(reviewStateAfterReport(state));
    }
  });
});

describe('resolution transition', () => {
  it('closes an open review to the chosen resolution', () => {
    expect(reviewStateAfterResolution('under_review', 'cleared')).toBe('cleared');
    expect(reviewStateAfterResolution('under_review', 'withheld')).toBe('withheld');
  });

  it('leaves any other state untouched, and reports it as unresolvable', () => {
    for (const state of ['none', 'cleared', 'withheld'] satisfies AssetReviewState[]) {
      expect(reviewStateAfterResolution(state, 'cleared')).toBe(state);
      expect(canResolveReview(state)).toBe(false);
    }

    expect(canResolveReview('under_review')).toBe(true);
  });
});

describe('discovery feed exclusion (Requirement 16.9)', () => {
  it('excludes an asset while it is under review', () => {
    expect(isExcludedFromDiscoveryFeed('under_review')).toBe(true);
  });

  it('keeps a withheld asset excluded', () => {
    expect(isExcludedFromDiscoveryFeed('withheld')).toBe(true);
  });

  it('admits an unreported or cleared asset as far as review state is concerned', () => {
    expect(isExcludedFromDiscoveryFeed('none')).toBe(false);
    expect(isExcludedFromDiscoveryFeed('cleared')).toBe(false);
  });

  it('agrees with the exported discoverable-state list', () => {
    expect([...DISCOVERABLE_REVIEW_STATES]).toEqual(['none', 'cleared']);
    for (const state of ASSET_REVIEW_STATES) {
      expect(DISCOVERABLE_REVIEW_STATES.includes(state)).toBe(!isExcludedFromDiscoveryFeed(state));
    }
  });

  it('excludes an asset immediately after a report, for every starting state', () => {
    // The end-to-end shape of 16.8 -> 16.9: accepting a report always leaves the
    // asset out of the feed, whatever state it was in.
    for (const state of ASSET_REVIEW_STATES) {
      expect(isExcludedFromDiscoveryFeed(reviewStateAfterReport(state))).toBe(true);
    }
  });
});
