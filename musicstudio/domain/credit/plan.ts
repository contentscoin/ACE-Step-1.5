/**
 * Billing plans and their quotas (Requirements 2.1, 2.5, 2.8, 2.14).
 *
 * One definition per plan carries every limit Requirement 2 asks for:
 *
 * - 2.1  `initialCredits`      — granted once, at account creation
 * - 2.8  `monthlyCredits`      — added on each billing-cycle renewal
 * - 2.5  `maxJobsPerMonth`, `maxConcurrentJobs`
 * - 2.14 `maxMonthlyAssetsByKind` — a per-Asset_Kind monthly ceiling
 *
 * The numbers are product decisions: neither the requirements document nor its
 * appendix fixes credit amounts or plan ceilings. They are stated here once so
 * the service, the SQL seed (`db/migrations/0010_credit.sql`) and the tests all
 * read the same values, and so changing a price is a one-line change.
 */

import { ASSET_KINDS, type AssetKind } from '../asset-kind';

export const FREE_PLAN_ID = 'free';
export const CREATOR_PLAN_ID = 'creator';
export const STUDIO_PLAN_ID = 'studio';

export interface PlanDefinition {
  readonly planId: string;
  /** Requirement 2.1. */
  readonly initialCredits: number;
  /** Requirement 2.8. */
  readonly monthlyCredits: number;
  /** Requirement 2.5. */
  readonly maxJobsPerMonth: number;
  /** Requirement 2.5 — counted over jobs that are charged but not yet settled. */
  readonly maxConcurrentJobs: number;
  /** Requirement 2.14 — every Asset_Kind has an explicit ceiling. */
  readonly maxMonthlyAssetsByKind: Readonly<Record<AssetKind, number>>;
  /**
   * Requirement 13.4's 무손실 다운로드 entitlement.
   *
   * A plan field rather than a separate table, because 13.4 asks a download to name "필요한
   * 요금제" and that answer is exactly "the plans whose flag is true" — derivable from the
   * plan list itself, with nothing to keep in step.
   */
  readonly losslessDownload: boolean;
}

const FREE_PLAN: PlanDefinition = {
  planId: FREE_PLAN_ID,
  initialCredits: 100,
  monthlyCredits: 100,
  maxJobsPerMonth: 30,
  maxConcurrentJobs: 1,
  maxMonthlyAssetsByKind: { song: 10, bgm: 10, sfx: 20, dialogue: 10, stem: 5, mix: 5 },
  // Requirement 13.4: the free plan is the one that does not include it, which is what
  // gives 13.4 something to refuse and a plan to name.
  losslessDownload: false,
};

const CREATOR_PLAN: PlanDefinition = {
  planId: CREATOR_PLAN_ID,
  initialCredits: 2_000,
  monthlyCredits: 2_000,
  maxJobsPerMonth: 500,
  maxConcurrentJobs: 3,
  maxMonthlyAssetsByKind: { song: 200, bgm: 200, sfx: 400, dialogue: 200, stem: 100, mix: 100 },
  losslessDownload: true,
};

const STUDIO_PLAN: PlanDefinition = {
  planId: STUDIO_PLAN_ID,
  initialCredits: 10_000,
  monthlyCredits: 10_000,
  maxJobsPerMonth: 3_000,
  maxConcurrentJobs: 8,
  maxMonthlyAssetsByKind: { song: 1_000, bgm: 1_000, sfx: 2_000, dialogue: 1_000, stem: 500, mix: 500 },
  losslessDownload: true,
};

export const PLANS: readonly PlanDefinition[] = [FREE_PLAN, CREATOR_PLAN, STUDIO_PLAN];

const PLANS_BY_ID = new Map(PLANS.map((plan) => [plan.planId, plan]));

/** The plan a newly created account starts on (Requirement 2.1). */
export const DEFAULT_PLAN: PlanDefinition = FREE_PLAN;

export function findPlan(planId: string): PlanDefinition | undefined {
  return PLANS_BY_ID.get(planId);
}

export function planIds(): readonly string[] {
  return [...PLANS_BY_ID.keys()];
}

/** Requirement 2.14 ceiling for one kind. */
export function monthlyAssetCap(plan: PlanDefinition, assetKind: AssetKind): number {
  return plan.maxMonthlyAssetsByKind[assetKind];
}

export type PlanViolation =
  | 'initial_credits_negative'
  | 'monthly_credits_negative'
  | 'max_jobs_per_month_not_positive'
  | 'max_concurrent_jobs_not_positive'
  | 'asset_kind_cap_missing';

export function validatePlan(plan: PlanDefinition): PlanViolation[] {
  const violations: PlanViolation[] = [];

  if (!Number.isInteger(plan.initialCredits) || plan.initialCredits < 0) {
    violations.push('initial_credits_negative');
  }
  if (!Number.isInteger(plan.monthlyCredits) || plan.monthlyCredits < 0) {
    violations.push('monthly_credits_negative');
  }
  if (!Number.isInteger(plan.maxJobsPerMonth) || plan.maxJobsPerMonth <= 0) {
    violations.push('max_jobs_per_month_not_positive');
  }
  if (!Number.isInteger(plan.maxConcurrentJobs) || plan.maxConcurrentJobs <= 0) {
    violations.push('max_concurrent_jobs_not_positive');
  }
  for (const assetKind of ASSET_KINDS) {
    const cap = plan.maxMonthlyAssetsByKind[assetKind];
    if (!Number.isInteger(cap) || cap <= 0) violations.push('asset_kind_cap_missing');
  }

  return violations;
}
