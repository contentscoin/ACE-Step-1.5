import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import { isExcludedFromDiscoveryFeed } from '../../../domain/moderation/review-state';
import type { ReviewResolution } from '../../../domain/moderation/review-state';
import { reportTargetNotFound } from '../../../services/moderation/errors';
import type { ReportReason, ReportService } from '../../../services/moderation/report-service';
import {
  getReviewStateSchema,
  resolveReviewSchema,
  submitReportSchema,
} from '../schemas/moderation-schemas';

/**
 * Report intake and review-state routes (Requirements 16.8, 16.9).
 *
 * Report submission is **not** behind the auth middleware. Requirement 16.8 says
 * 방문자 — a visitor — and requiring a session would narrow the criterion to
 * registered users. The reporter is attributed only when an authenticated account is
 * already on the request, and is otherwise recorded as anonymous.
 *
 * A report against an asset that is not publicly visible answers 404 rather than 403:
 * the same answer an unknown id gets, so the endpoint cannot be used to discover
 * which private assets exist.
 *
 * Review resolution requires authentication. Operator *authorisation* — the role
 * check separating an operator from any signed-in account — is task 8.2's
 * Admin_Console and is deliberately not invented here.
 */
export interface ModerationRouteOptions {
  readonly reports: ReportService;
  readonly authenticate: preHandlerHookHandler;
}

export function registerModerationRoutes(
  app: FastifyInstance,
  options: ModerationRouteOptions,
): void {
  const { reports } = options;

  // Requirement 16.8.
  app.post<{ Params: { assetId: string }; Body: { reason: ReportReason; detail?: string } }>(
    '/assets/:assetId/reports',
    { schema: submitReportSchema },
    async (request, reply) => {
      const { detail } = request.body;
      const acceptance = reports.submit({
        assetId: request.params.assetId,
        reporterAccountId: request.authenticatedAccount?.accountId ?? null,
        reason: request.body.reason,
        ...(detail === undefined ? {} : { detail }),
      });

      // 202: the report is accepted and the asset marked; the review itself is not
      // yet decided, which is exactly what Requirement 16.8 promises.
      return reply.code(202).send({
        reportId: acceptance.report.reportId,
        assetId: acceptance.report.assetId,
        reason: acceptance.report.reason,
        submittedAtMs: acceptance.report.submittedAtMs,
        reviewState: acceptance.reviewState,
        excludedFromDiscoveryFeed: acceptance.excludedFromDiscoveryFeed,
        openReportCount: acceptance.openReportCount,
      });
    },
  );

  // Requirement 16.9 — the state task 5.3's discovery feed filters on.
  app.get<{ Params: { assetId: string } }>(
    '/assets/:assetId/review-state',
    { schema: getReviewStateSchema, preHandler: options.authenticate },
    async (request) => {
      const { assetId } = request.params;
      const openReports = reports.reportsFor(assetId);
      const reviewState = reports.reviewStateOf(assetId);
      if (reviewState === 'none' && openReports.length === 0) {
        throw reportTargetNotFound(assetId);
      }

      return {
        assetId,
        reviewState,
        excludedFromDiscoveryFeed: isExcludedFromDiscoveryFeed(reviewState),
        openReportCount: openReports.length,
      };
    },
  );

  app.post<{ Params: { assetId: string }; Body: { resolution: ReviewResolution } }>(
    '/assets/:assetId/review-resolution',
    { schema: resolveReviewSchema, preHandler: options.authenticate },
    async (request) => {
      const { assetId } = request.params;
      const reviewState = reports.resolve(assetId, request.body.resolution);

      return {
        assetId,
        reviewState,
        excludedFromDiscoveryFeed: isExcludedFromDiscoveryFeed(reviewState),
        openReportCount: reports.reportsFor(assetId).length,
      };
    },
  );
}
