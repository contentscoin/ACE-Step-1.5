import { randomUUID } from 'node:crypto';

import type { CreditRefundPort, EnginePricingPort, RefundRequest } from '../../adapters/registry/ports';
import type { AssetKind } from '../../domain/asset-kind';
import {
  DEFAULT_PLAN,
  findPlan,
  planIds,
  type PlanDefinition,
} from '../../domain/credit/plan';
import {
  costOf,
  pricingKey,
  SOUND_PACK_CUE_COUNT,
  type PricingTable,
} from '../../domain/credit/pricing';
import type { ChargeKind, CreditLedgerEntry } from '../../domain/credit/ledger-entry';
import {
  buildUsageSnapshot,
  checkPlanQuotas,
  summariseUsage,
  type UsageSnapshot,
} from '../../domain/credit/usage';
import { systemClock, type Clock } from '../clock';

import { creditAuditDraft, noopCreditAuditSink, type CreditAuditSink } from './audit';
import type { CreditBalanceStore } from './balance-store';
import type { AccountPlanStore } from './account-plan-store';
import {
  chargeAmountInvalid,
  concurrentJobLimitReached,
  creditBalanceInsufficient,
  monthlyAssetLimitReached,
  monthlyJobLimitReached,
  planNotFound,
  pricingEntryNotFound,
} from './errors';
import type { CreditLedgerStore } from './ledger';
import { createDefaultPricingTable, MIXDOWN_ENGINE_ID } from './pricing-table';

/**
 * Credit_Service (Requirements 2.1–2.14; design §2.4).
 *
 * ## How the pieces divide up
 *
 * - **Pricing and plan rules** are pure functions in `domain/credit/`.
 * - **Balance and concurrency** live in `CreditBalanceStore`, whose two guarded
 *   operations are atomic (see that module for why nothing else may decide).
 * - **History** is the append-only `CreditLedgerStore`; balance, monthly usage
 *   and refund eligibility are all folds over it, so no derived counter can
 *   drift from the entries.
 * - **This module** sequences them and turns a refusal into the exact HTTP
 *   status its criterion names.
 *
 * ## Ordering, and what happens when a step fails
 *
 * A charge runs: resolve plan → resolve price (2.11) → monthly caps (2.5, 2.14)
 * → acquire a concurrency slot (2.6) → debit (2.3) → append the ledger entry and
 * audit it (2.2). The slot is taken *before* the debit so that the in-flight
 * count a rejected request reports is the real one, and every failure after the
 * slot is taken releases it again — a rejected request must leave the account
 * exactly as it found it, which is what Requirements 20.11/20.13/20.22 assert
 * from the routing side.
 *
 * ## Integration point for Job_Orchestrator (task 1.5)
 *
 * 1.5 calls `chargeGeneration` before submitting to an engine, then exactly one
 * of `settleJob` (success) or `refundJob` (failure, cancellation, timeout) when
 * the job leaves the in-flight state. `refund` is the same path reached through
 * the registry's `CreditRefundPort`, so the Requirement 20.15 timeout refund and
 * the Requirement 2.4 failure refund cannot diverge. Both are idempotent per
 * `jobId`, so a retried callback is harmless.
 */

export interface ChargeRecord {
  readonly accountId: string;
  readonly jobId: string;
  readonly chargeKind: ChargeKind;
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly pricingKey: string;
  readonly amount: number;
  readonly outputCount: number;
  readonly durationMs: number;
  readonly balanceAfter: number;
  readonly jobsInFlight: number;
  readonly chargedAtMs: number;
  /** `false` when this `jobId` was already charged; nothing was debited again. */
  readonly newlyCharged: boolean;
}

export interface RefundResult {
  readonly accountId: string;
  readonly jobId: string;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly refundedAtMs: number;
  /** `false` when the job was already refunded, or was never charged. */
  readonly newlyRefunded: boolean;
}

export interface GrantResult {
  readonly accountId: string;
  readonly planId: string;
  readonly amount: number;
  readonly balance: number;
  readonly grantedAtMs: number;
  /** `false` when the account had already been provisioned (2.1 is once-only). */
  readonly newlyGranted: boolean;
}

export interface PlanScopedRequest {
  readonly accountId: string;
  /** Overrides the stored plan; 1.5 passes it when it already knows. */
  readonly planId?: string;
}

export interface GenerationChargeRequest extends PlanScopedRequest {
  readonly jobId: string;
  readonly assetKind: AssetKind;
  readonly engineId: string;
  /** Requested output length; Requirement 2.10 reflects it in the cost. */
  readonly durationMs: number;
  /** `batch_size` from Requirement 2.2. */
  readonly outputCount: number;
}

export interface MixdownChargeRequest extends PlanScopedRequest {
  readonly jobId: string;
  /** Requirement 2.12 charges the mixdown entry by render duration. */
  readonly renderDurationMs: number;
  readonly engineId?: string;
}

export interface SoundPackChargeRequest extends PlanScopedRequest {
  readonly jobId: string;
  readonly engineId: string;
  /** Length of one cue; all 78 are charged in a single record (2.13). */
  readonly cueDurationMs: number;
}

export interface QuoteRequest {
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly durationMs: number;
  readonly outputCount: number;
}

export interface Quote {
  readonly pricingKey: string;
  readonly amount: number;
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly durationMs: number;
  readonly outputCount: number;
}

/**
 * Credit_Service surface.
 *
 * Extends the two narrow ports task 1.3 already depends on, so the Provider_
 * Registry keeps talking to `missingPricingKeys` and `refund` and never learns
 * that a whole service now sits behind them.
 */
export interface CreditService extends EnginePricingPort, CreditRefundPort {
  /** Requirement 2.1. */
  provisionAccount(request: PlanScopedRequest): Promise<GrantResult>;
  /** Requirements 2.9–2.11, without charging. */
  quote(request: QuoteRequest): Quote;
  /** Requirements 2.2, 2.3, 2.5, 2.6, 2.10, 2.11, 2.14. */
  chargeGeneration(request: GenerationChargeRequest): Promise<ChargeRecord>;
  /** Requirement 2.12. */
  chargeMixdown(request: MixdownChargeRequest): Promise<ChargeRecord>;
  /** Requirement 2.13. */
  chargeSoundPack(request: SoundPackChargeRequest): Promise<ChargeRecord>;
  /** Requirement 2.4. */
  refundJob(request: {
    readonly accountId: string;
    readonly jobId: string;
    readonly reason: string;
  }): Promise<RefundResult>;
  /** Success path: frees the concurrency slot without moving credits. */
  settleJob(request: { readonly accountId: string; readonly jobId: string }): Promise<number>;
  /** Requirement 2.7. */
  usage(request: PlanScopedRequest): Promise<UsageSnapshot>;
  /** Requirement 2.8. */
  renewBillingCycle(request: PlanScopedRequest): Promise<GrantResult>;
  planFor(request: PlanScopedRequest): Promise<PlanDefinition>;
}

export interface CreditServiceDependencies {
  readonly balances: CreditBalanceStore;
  readonly ledger: CreditLedgerStore;
  readonly accountPlans: AccountPlanStore;
  readonly clock?: Clock;
  readonly auditSink?: CreditAuditSink;
  /** Defaults to the registered rate card in `pricing-table.ts`. */
  readonly pricing?: PricingTable;
  readonly generateEntryId?: () => string;
}

export function createCreditService(deps: CreditServiceDependencies): CreditService {
  const clock = deps.clock ?? systemClock;
  const audit = deps.auditSink ?? noopCreditAuditSink;
  const pricing = deps.pricing ?? createDefaultPricingTable();
  const generateEntryId = deps.generateEntryId ?? randomUUID;
  const { balances, ledger, accountPlans } = deps;

  async function resolvePlan(request: PlanScopedRequest): Promise<PlanDefinition> {
    const planId = request.planId ?? (await accountPlans.planIdFor(request.accountId));
    if (planId === undefined) return DEFAULT_PLAN;

    const plan = findPlan(planId);
    if (plan === undefined) throw planNotFound(planId, planIds());
    return plan;
  }

  function quoteOf(request: QuoteRequest): Quote {
    const key = pricingKey(request.assetKind, request.engineId);
    const entry = pricing.entryFor(request.assetKind, request.engineId);
    if (entry === undefined) {
      // Requirement 2.11.
      throw pricingEntryNotFound({
        assetKind: request.assetKind,
        engineId: request.engineId,
        pricingKey: key,
      });
    }

    const amount = costOf(entry, {
      durationMs: request.durationMs,
      outputCount: request.outputCount,
    });
    if (!Number.isInteger(amount) || amount <= 0) throw chargeAmountInvalid(amount);

    return {
      pricingKey: key,
      amount,
      assetKind: request.assetKind,
      engineId: request.engineId,
      durationMs: request.durationMs,
      outputCount: request.outputCount,
    };
  }

  /** The one charge path; the three public variants only choose its inputs. */
  async function charge(input: {
    readonly accountId: string;
    readonly planId?: string;
    readonly jobId: string;
    readonly chargeKind: ChargeKind;
    readonly quote: Quote;
  }): Promise<ChargeRecord> {
    const plan = await resolvePlan({
      accountId: input.accountId,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
    });
    const { quote } = input;

    // Requirements 2.5 and 2.14 — a snapshot decision, safe because exceeding a
    // monthly ceiling by one concurrent request is bounded by the concurrency
    // cap taken immediately below.
    const usage = summariseUsage(await ledger.entriesFor(input.accountId));
    const quotas = checkPlanQuotas({
      plan,
      usage,
      assetKind: quote.assetKind,
      requestedOutputs: quote.outputCount,
    });
    if (!quotas.ok) {
      if (quotas.violation === 'monthly_job_limit') {
        throw monthlyJobLimitReached({
          planId: plan.planId,
          monthlyJobLimit: quotas.limit,
          jobsChargedThisMonth: quotas.used,
        });
      }
      throw monthlyAssetLimitReached({
        planId: plan.planId,
        assetKind: quote.assetKind,
        monthlyAssetLimit: quotas.limit,
        outputsThisMonth: quotas.used,
        requestedOutputs: quotas.requested,
      });
    }

    // Requirement 2.6 — atomic, so two simultaneous requests cannot both pass.
    const slot = await balances.tryAcquireJobSlot(input.accountId, plan.maxConcurrentJobs);
    if (!slot.acquired) {
      throw concurrentJobLimitReached({
        jobsInFlight: slot.jobsInFlight,
        concurrentJobLimit: plan.maxConcurrentJobs,
        planId: plan.planId,
      });
    }

    try {
      // Requirements 2.2, 2.3 — atomic guard-and-decrement.
      const debit = await balances.tryDebit(input.accountId, quote.amount);
      if (!debit.applied) {
        throw creditBalanceInsufficient({
          requiredCredits: quote.amount,
          balance: debit.balance,
        });
      }

      const chargedAtMs = clock.now().getTime();
      const entry: CreditLedgerEntry = {
        entryId: generateEntryId(),
        accountId: input.accountId,
        entryType: 'charge',
        amount: -quote.amount,
        jobId: input.jobId,
        chargeKind: input.chargeKind,
        assetKind: quote.assetKind,
        engineId: quote.engineId,
        durationMs: quote.durationMs,
        outputCount: quote.outputCount,
        reason: input.chargeKind,
        occurredAtMs: chargedAtMs,
      };

      const appended = await ledger.append(entry);
      if (!appended.appended) {
        // This jobId was already charged. Undo this debit rather than charging
        // twice, and report the charge that stands.
        const restored = await balances.credit(input.accountId, quote.amount);
        const existing = appended.entry;
        return {
          accountId: input.accountId,
          jobId: input.jobId,
          chargeKind: existing.chargeKind ?? input.chargeKind,
          assetKind: existing.assetKind ?? quote.assetKind,
          engineId: existing.engineId ?? quote.engineId,
          pricingKey: pricingKey(
            existing.assetKind ?? quote.assetKind,
            existing.engineId ?? quote.engineId,
          ),
          amount: -existing.amount,
          outputCount: existing.outputCount ?? quote.outputCount,
          durationMs: existing.durationMs ?? quote.durationMs,
          balanceAfter: restored,
          jobsInFlight: await balances.releaseJobSlot(input.accountId),
          chargedAtMs: existing.occurredAtMs,
          newlyCharged: false,
        };
      }

      // Requirement 2.2 — the deduction is audited (design §4.4).
      audit.record(
        creditAuditDraft({
          entry,
          balanceBefore: debit.balance + quote.amount,
          balanceAfter: debit.balance,
        }),
      );

      return {
        accountId: input.accountId,
        jobId: input.jobId,
        chargeKind: input.chargeKind,
        assetKind: quote.assetKind,
        engineId: quote.engineId,
        pricingKey: quote.pricingKey,
        amount: quote.amount,
        outputCount: quote.outputCount,
        durationMs: quote.durationMs,
        balanceAfter: debit.balance,
        jobsInFlight: slot.jobsInFlight,
        chargedAtMs,
        newlyCharged: true,
      };
    } catch (error) {
      // Nothing is in flight if the charge did not complete.
      await balances.releaseJobSlot(input.accountId);
      throw error;
    }
  }

  async function grant(input: {
    readonly accountId: string;
    readonly plan: PlanDefinition;
    readonly amount: number;
    readonly entryType: 'initial_grant' | 'cycle_renewal';
    readonly reason: string;
  }): Promise<GrantResult> {
    const grantedAtMs = clock.now().getTime();
    const entry: CreditLedgerEntry = {
      entryId: generateEntryId(),
      accountId: input.accountId,
      entryType: input.entryType,
      amount: input.amount,
      jobId: null,
      chargeKind: null,
      assetKind: null,
      engineId: null,
      durationMs: null,
      outputCount: null,
      reason: input.reason,
      occurredAtMs: grantedAtMs,
    };

    const balanceBefore = await balances.balanceOf(input.accountId);

    // `initialise` is the only guarded grant: it declines when the account
    // already holds an operational balance.
    const granted =
      input.entryType === 'initial_grant'
        ? await balances.initialise(input.accountId, input.amount)
        : { applied: true, balance: await balances.credit(input.accountId, input.amount) };

    if (!granted.applied) {
      // The credits were not added, so no entry may claim they were. Appending
      // one anyway would make the ledger fold disagree with the balance — the
      // very drift `account_credit_balance_violation` exists to detect — and
      // would report a grant that never happened.
      return {
        accountId: input.accountId,
        planId: input.plan.planId,
        amount: 0,
        balance: granted.balance,
        grantedAtMs,
        newlyGranted: false,
      };
    }

    await ledger.append(entry);
    audit.record(creditAuditDraft({ entry, balanceBefore, balanceAfter: granted.balance }));

    return {
      accountId: input.accountId,
      planId: input.plan.planId,
      amount: input.amount,
      balance: granted.balance,
      grantedAtMs,
      newlyGranted: true,
    };
  }

  async function refundJob(request: {
    readonly accountId: string;
    readonly jobId: string;
    readonly reason: string;
  }): Promise<RefundResult> {
    const chargeEntry = await ledger.findByJob(request.jobId, 'charge');
    const refundedAtMs = clock.now().getTime();

    if (chargeEntry === undefined) {
      // Nothing was ever debited for this job, so there is nothing to return.
      return {
        accountId: request.accountId,
        jobId: request.jobId,
        amount: 0,
        balanceAfter: await balances.balanceOf(request.accountId),
        refundedAtMs,
        newlyRefunded: false,
      };
    }

    // Requirement 2.4 — the full amount of the original deduction.
    const amount = -chargeEntry.amount;
    const entry: CreditLedgerEntry = {
      entryId: generateEntryId(),
      accountId: chargeEntry.accountId,
      entryType: 'refund',
      amount,
      jobId: request.jobId,
      chargeKind: chargeEntry.chargeKind,
      assetKind: chargeEntry.assetKind,
      engineId: chargeEntry.engineId,
      durationMs: chargeEntry.durationMs,
      outputCount: chargeEntry.outputCount,
      reason: request.reason,
      occurredAtMs: refundedAtMs,
    };

    // The unique (jobId, entryType) constraint is what makes this idempotent: a
    // duplicate callback loses the append and therefore moves no credits.
    const appended = await ledger.append(entry);
    if (!appended.appended) {
      return {
        accountId: chargeEntry.accountId,
        jobId: request.jobId,
        amount: appended.entry.amount,
        balanceAfter: await balances.balanceOf(chargeEntry.accountId),
        refundedAtMs: appended.entry.occurredAtMs,
        newlyRefunded: false,
      };
    }

    const balanceBefore = await balances.balanceOf(chargeEntry.accountId);
    const balance = await balances.credit(chargeEntry.accountId, amount);
    await balances.releaseJobSlot(chargeEntry.accountId);
    audit.record(creditAuditDraft({ entry, balanceBefore, balanceAfter: balance }));

    return {
      accountId: chargeEntry.accountId,
      jobId: request.jobId,
      amount,
      balanceAfter: balance,
      refundedAtMs,
      newlyRefunded: true,
    };
  }

  return {
    planFor: resolvePlan,

    quote: quoteOf,

    // Requirement 20.16/20.17 — the registry only asks which keys are missing.
    missingPricingKeys: (engineId, assetKinds) => pricing.missingKeys(engineId, assetKinds),

    async provisionAccount(request) {
      const plan = await resolvePlan(request);
      await accountPlans.assign(request.accountId, plan.planId);

      // Requirement 2.1 is once-only: an account that already has its opening
      // grant is left alone, so a retried signup cannot double the balance.
      const existing = await ledger.entriesFor(request.accountId);
      const alreadyGranted = existing.some((entry) => entry.entryType === 'initial_grant');
      if (alreadyGranted) {
        return {
          accountId: request.accountId,
          planId: plan.planId,
          amount: 0,
          balance: await balances.balanceOf(request.accountId),
          grantedAtMs: clock.now().getTime(),
          newlyGranted: false,
        };
      }

      return grant({
        accountId: request.accountId,
        plan,
        amount: plan.initialCredits,
        entryType: 'initial_grant',
        reason: 'initial_grant',
      });
    },

    async chargeGeneration(request) {
      return charge({
        accountId: request.accountId,
        ...(request.planId === undefined ? {} : { planId: request.planId }),
        jobId: request.jobId,
        chargeKind: 'generation',
        quote: quoteOf({
          assetKind: request.assetKind,
          engineId: request.engineId,
          durationMs: request.durationMs,
          outputCount: request.outputCount,
        }),
      });
    },

    async chargeMixdown(request) {
      return charge({
        accountId: request.accountId,
        ...(request.planId === undefined ? {} : { planId: request.planId }),
        jobId: request.jobId,
        chargeKind: 'mixdown',
        quote: quoteOf({
          assetKind: 'mix',
          engineId: request.engineId ?? MIXDOWN_ENGINE_ID,
          durationMs: request.renderDurationMs,
          outputCount: 1,
        }),
      });
    },

    async chargeSoundPack(request) {
      return charge({
        accountId: request.accountId,
        ...(request.planId === undefined ? {} : { planId: request.planId }),
        jobId: request.jobId,
        chargeKind: 'sound_pack',
        // Requirement 2.13: all 78 cues, one deduction record.
        quote: quoteOf({
          assetKind: 'sfx',
          engineId: request.engineId,
          durationMs: request.cueDurationMs,
          outputCount: SOUND_PACK_CUE_COUNT,
        }),
      });
    },

    refundJob,

    /** `CreditRefundPort` — the registry's Requirement 20.15 timeout refund. */
    async refund(request: RefundRequest): Promise<void> {
      await refundJob({
        accountId: request.accountId,
        jobId: request.jobId,
        reason: request.reason,
      });
    },

    /**
     * Frees the slot a charged job holds.
     *
     * Contract with Job_Orchestrator: exactly one of `settleJob` or `refundJob`
     * per charged job. Settling a job that was never charged, or one that was
     * already refunded, is a no-op rather than a decrement, so a stray callback
     * cannot free a slot that belongs to a different job.
     */
    async settleJob(request) {
      const charged = await ledger.findByJob(request.jobId, 'charge');
      const refunded = await ledger.findByJob(request.jobId, 'refund');
      if (charged === undefined || refunded !== undefined) {
        return balances.jobsInFlight(request.accountId);
      }
      return balances.releaseJobSlot(request.accountId);
    },

    async usage(request) {
      const plan = await resolvePlan(request);
      return buildUsageSnapshot({
        accountId: request.accountId,
        plan,
        balance: await balances.balanceOf(request.accountId),
        usage: summariseUsage(await ledger.entriesFor(request.accountId)),
        jobsInFlight: await balances.jobsInFlight(request.accountId),
      });
    },

    async renewBillingCycle(request) {
      const plan = await resolvePlan(request);
      await accountPlans.assign(request.accountId, plan.planId);

      // Requirement 2.8: the monthly aggregate resets because this entry opens a
      // new billing period, not because a counter was overwritten.
      return grant({
        accountId: request.accountId,
        plan,
        amount: plan.monthlyCredits,
        entryType: 'cycle_renewal',
        reason: 'billing_cycle_renewal',
      });
    },
  };
}
