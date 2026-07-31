/**
 * Report intake and review state (Requirements 16.8, 16.9).
 *
 * 16.8: a visitor reports a public asset -> the report is accepted and the asset is
 * marked under review. Reporters may be anonymous visitors, so `reporterAccountId`
 * is nullable, and reports are not deduplicated: how many arrived is information an
 * operator wants.
 *
 * 16.9: while under review the asset is excluded from the discovery feed. The state
 * and the predicate are exposed here; **Sharing_Service (task 5.3) owns the feed
 * query** and ANDs `isExcludedFromDiscoveryFeed` into it. See `reviewStateOf` and
 * `isExcludedFromDiscoveryFeed` below for that integration point, and
 * `db/migrations/0009_content_report.sql` for the SQL view 5.3 can select from
 * instead.
 *
 * Whether an asset is public at all is Sharing_Service's fact, reached through the
 * narrow `PublicAssetLookupPort`: a report against a private or unknown asset gets
 * 404, which refuses the report without disclosing that the asset exists.
 */

import { randomUUID } from 'node:crypto';

import {
  canResolveReview,
  isExcludedFromDiscoveryFeed,
  reviewStateAfterReport,
  reviewStateAfterResolution,
  type AssetReviewState,
  type ReviewResolution,
} from '../../domain/moderation/review-state';
import type { Clock } from '../clock';

import { reportTargetNotFound, reviewNotOpen } from './errors';

export const REPORT_REASONS = [
  'policy_violation',
  'rights_infringement',
  'impersonation',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_DETAIL_MAX_LENGTH = 1_000;

export interface ContentReportDraft {
  readonly assetId: string;
  /** `null` for an unauthenticated visitor (Requirement 16.8 says "방문자"). */
  readonly reporterAccountId: string | null;
  readonly reason: ReportReason;
  readonly detail?: string;
}

export interface ContentReport extends ContentReportDraft {
  readonly reportId: string;
  readonly submittedAtMs: number;
}

/** Persistence seam. Backed by `content_report` in production. */
export interface ContentReportStorePort {
  append(report: ContentReport): void;
  reportsFor(assetId: string): readonly ContentReport[];
  reviewStateOf(assetId: string): AssetReviewState;
  setReviewState(assetId: string, state: AssetReviewState): void;
}

/** Sharing_Service's fact (task 5.3), narrowed to the one question 16.8 asks. */
export interface PublicAssetLookupPort {
  isPubliclyVisible(assetId: string): boolean;
}

export interface ReportServiceDependencies {
  readonly store: ContentReportStorePort;
  readonly publicAssets: PublicAssetLookupPort;
  readonly clock: Clock;
  /** Injectable so a test can assert on stable identifiers. */
  readonly newReportId?: () => string;
}

export interface ReportAcceptance {
  readonly report: ContentReport;
  readonly reviewState: AssetReviewState;
  /** Requirement 16.9, stated in the response so a caller need not re-derive it. */
  readonly excludedFromDiscoveryFeed: boolean;
  readonly openReportCount: number;
}

export class ReportService {
  private readonly deps: ReportServiceDependencies;
  private readonly newReportId: () => string;

  constructor(deps: ReportServiceDependencies) {
    this.deps = deps;
    this.newReportId = deps.newReportId ?? (() => randomUUID());
  }

  /** Requirement 16.8. */
  submit(draft: ContentReportDraft): ReportAcceptance {
    if (!this.deps.publicAssets.isPubliclyVisible(draft.assetId)) {
      throw reportTargetNotFound(draft.assetId);
    }

    const report: ContentReport = {
      ...draft,
      reportId: this.newReportId(),
      submittedAtMs: this.deps.clock.now().getTime(),
    };
    this.deps.store.append(report);

    const reviewState = reviewStateAfterReport(this.deps.store.reviewStateOf(draft.assetId));
    this.deps.store.setReviewState(draft.assetId, reviewState);

    return {
      report,
      reviewState,
      excludedFromDiscoveryFeed: isExcludedFromDiscoveryFeed(reviewState),
      openReportCount: this.deps.store.reportsFor(draft.assetId).length,
    };
  }

  reviewStateOf(assetId: string): AssetReviewState {
    return this.deps.store.reviewStateOf(assetId);
  }

  /**
   * Requirement 16.9 — the predicate task 5.3's feed query applies.
   *
   * Review state is only one of the feed's conditions; publication and soft-delete
   * are 5.3's and are ANDed alongside it.
   */
  isExcludedFromDiscoveryFeed(assetId: string): boolean {
    return isExcludedFromDiscoveryFeed(this.reviewStateOf(assetId));
  }

  reportsFor(assetId: string): readonly ContentReport[] {
    return this.deps.store.reportsFor(assetId);
  }

  /** Operator closing a review. The console UI is task 8.2. */
  resolve(assetId: string, resolution: ReviewResolution): AssetReviewState {
    const current = this.deps.store.reviewStateOf(assetId);
    if (!canResolveReview(current)) {
      throw reviewNotOpen(assetId, current);
    }

    const next = reviewStateAfterResolution(current, resolution);
    this.deps.store.setReviewState(assetId, next);
    return next;
  }
}

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}
