/**
 * Monthly usage aggregation and plan-quota decisions (Requirements 2.5, 2.6,
 * 2.7, 2.14).
 *
 * Everything here is a fold over the ledger, so there is no second counter that
 * could disagree with the entries — the ledger is the only state.
 *
 * A refunded job is excluded from all three aggregates. Requirement 2.4 returns
 * the *full* amount for a failed job, and Requirement 2.14 caps "generated
 * assets per month"; a job that produced nothing and cost nothing must therefore
 * consume neither credits nor the job count nor an Asset_Kind slot.
 */

import { ASSET_KINDS, type AssetKind } from '../asset-kind';

import type { PlanDefinition } from './plan';
import { monthlyAssetCap } from './plan';
import { currentPeriodStartMs, type CreditLedgerEntry } from './ledger-entry';

export interface MonthlyUsage {
  /** Instant the billing period in force began (Requirement 2.8). */
  readonly periodStartMs: number;
  /** Requirement 2.7 "당월 사용 크레딧" — net of refunds. */
  readonly creditsUsed: number;
  /** Charged, unrefunded Generation_Jobs in the period (Requirement 2.5). */
  readonly jobsCharged: number;
  readonly creditsRefunded: number;
  /** Outputs produced per Asset_Kind (Requirement 2.14). */
  readonly outputsByKind: Readonly<Record<AssetKind, number>>;
}

function zeroOutputs(): Record<AssetKind, number> {
  return Object.fromEntries(ASSET_KINDS.map((kind) => [kind, 0])) as Record<AssetKind, number>;
}

/**
 * Aggregate the current billing period.
 *
 * `periodStartMs` defaults to the newest period-opening entry, which is what
 * makes a renewal (Requirement 2.8) reset the aggregate to zero without
 * mutating or deleting a single row.
 */
export function summariseUsage(
  entries: readonly CreditLedgerEntry[],
  periodStartMs: number = currentPeriodStartMs(entries),
): MonthlyUsage {
  const refundedJobIds = new Set(
    entries
      .filter((entry) => entry.entryType === 'refund' && entry.jobId !== null)
      .map((entry) => entry.jobId as string),
  );

  const outputsByKind = zeroOutputs();
  let creditsUsed = 0;
  let jobsCharged = 0;
  let creditsRefunded = 0;

  for (const entry of entries) {
    if (entry.occurredAtMs < periodStartMs) continue;

    if (entry.entryType === 'refund') {
      creditsRefunded += entry.amount;
      continue;
    }
    if (entry.entryType !== 'charge') continue;
    if (entry.jobId !== null && refundedJobIds.has(entry.jobId)) continue;

    creditsUsed += -entry.amount;
    jobsCharged += 1;
    if (entry.assetKind !== null) {
      outputsByKind[entry.assetKind] += entry.outputCount ?? 0;
    }
  }

  return { periodStartMs, creditsUsed, jobsCharged, creditsRefunded, outputsByKind };
}

/** Requirement 2.7 response body. */
export interface UsageSnapshot {
  readonly accountId: string;
  readonly planId: string;
  readonly balance: number;
  readonly creditsUsedThisMonth: number;
  readonly remainingMonthlyJobs: number;
  readonly monthlyJobLimit: number;
  readonly jobsInFlight: number;
  readonly concurrentJobLimit: number;
  readonly periodStartMs: number;
  /** Requirement 2.14 headroom, per Asset_Kind. */
  readonly remainingMonthlyAssetsByKind: Readonly<Record<AssetKind, number>>;
}

export function buildUsageSnapshot(input: {
  readonly accountId: string;
  readonly plan: PlanDefinition;
  readonly balance: number;
  readonly usage: MonthlyUsage;
  readonly jobsInFlight: number;
}): UsageSnapshot {
  const { plan, usage } = input;
  const remainingByKind = zeroOutputs();
  for (const assetKind of ASSET_KINDS) {
    remainingByKind[assetKind] = Math.max(
      0,
      monthlyAssetCap(plan, assetKind) - usage.outputsByKind[assetKind],
    );
  }

  return {
    accountId: input.accountId,
    planId: plan.planId,
    balance: input.balance,
    creditsUsedThisMonth: usage.creditsUsed,
    remainingMonthlyJobs: Math.max(0, plan.maxJobsPerMonth - usage.jobsCharged),
    monthlyJobLimit: plan.maxJobsPerMonth,
    jobsInFlight: input.jobsInFlight,
    concurrentJobLimit: plan.maxConcurrentJobs,
    periodStartMs: usage.periodStartMs,
    remainingMonthlyAssetsByKind: remainingByKind,
  };
}

export type QuotaViolation = 'monthly_job_limit' | 'monthly_asset_kind_limit';

export type QuotaDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly violation: QuotaViolation;
      readonly limit: number;
      readonly used: number;
      readonly requested: number;
      readonly assetKind: AssetKind | null;
    };

/**
 * Requirements 2.5 (monthly job ceiling) and 2.14 (per-Asset_Kind ceiling).
 *
 * The concurrency ceiling of 2.5/2.6 is deliberately *not* decided here: it is
 * the one limit that cannot be evaluated from a snapshot without racing, so it
 * is enforced by an atomic counter in `CreditBalanceStore` instead.
 */
export function checkPlanQuotas(input: {
  readonly plan: PlanDefinition;
  readonly usage: MonthlyUsage;
  readonly assetKind: AssetKind | null;
  readonly requestedOutputs: number;
}): QuotaDecision {
  const { plan, usage, assetKind } = input;

  if (usage.jobsCharged + 1 > plan.maxJobsPerMonth) {
    return {
      ok: false,
      violation: 'monthly_job_limit',
      limit: plan.maxJobsPerMonth,
      used: usage.jobsCharged,
      requested: 1,
      assetKind,
    };
  }

  if (assetKind !== null) {
    const cap = monthlyAssetCap(plan, assetKind);
    const used = usage.outputsByKind[assetKind];
    if (used + input.requestedOutputs > cap) {
      return {
        ok: false,
        violation: 'monthly_asset_kind_limit',
        limit: cap,
        used,
        requested: input.requestedOutputs,
        assetKind,
      };
    }
  }

  return { ok: true };
}
