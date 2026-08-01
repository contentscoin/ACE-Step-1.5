/**
 * The credit seam for a mixdown export (Requirement 2.12).
 *
 * Requirement 2.12 is one sentence — "믹스다운 단가 항목에 렌더링 길이를 반영한 크레딧을
 * 차감한다" — and every part of it already exists: `Credit_Service.chargeMixdown` is the
 * operation, `mix:musicstudio-mixdown` is the priced combination in
 * `services/credit/pricing-table.ts`, and `costOf` in `domain/credit/pricing.ts` is the
 * arithmetic. Nothing about pricing is restated here. What is declared here is the **narrow
 * view of `Credit_Service` that a mixdown needs**, so that:
 *
 * - `Mixdown_Renderer` depends on three methods rather than on the whole service, in the way
 *   `EnginePricingPort` and `CreditRefundPort` (`adapters/registry/ports.ts`) already narrow it
 *   for the Provider_Registry;
 * - the renderer's tests can supply a fake without standing up a ledger, a balance store and a
 *   plan store — the arrangement every other service test in this repository uses.
 *
 * `CreditService` satisfies this structurally, so the composition root passes the real service
 * and nothing adapts anything.
 *
 * ### Why `quote` and `usage` are in the view, and not only `chargeMixdown`
 *
 * Because of the order the renderer has to do things in, which is argued in
 * `mixdown-renderer.ts` and summarised here: the balance is checked *before* the render
 * (Requirement 2.3's 402 belongs at request time, not after a minute of GPU) and debited
 * *after* it (so that no mix is ever charged for and then not produced). `quote` prices the
 * render without touching the balance, `usage` reports the balance, and `chargeMixdown` is the
 * single deduction.
 *
 * ### There is no refund method here, deliberately
 *
 * This system has exactly one refund path — the job lifecycle's `engine_failed` transition,
 * reached through `services/sound/job-quality-rejection.ts` — and a second one would be a
 * second answer to Requirement 2.4. A mixdown needs none: it is charged only once a verified
 * mix exists, so there is never a charge to give back. See `mixdown-renderer.ts`.
 */

import type { AssetKind } from '../../domain/asset-kind';

/** The subset of `Quote` a mixdown reads. */
export interface MixdownCreditQuote {
  readonly pricingKey: string;
  readonly amount: number;
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly durationMs: number;
  readonly outputCount: number;
}

/** The subset of `ChargeRecord` a mixdown reports. */
export interface MixdownChargeRecord {
  readonly accountId: string;
  readonly jobId: string;
  readonly amount: number;
  readonly durationMs: number;
  readonly balanceAfter: number;
  readonly chargedAtMs: number;
  /** `false` when this `jobId` was already charged; nothing was debited again. */
  readonly newlyCharged: boolean;
}

/**
 * `Credit_Service` as a mixdown sees it.
 *
 * Method names and shapes are the service's own, so this is a view rather than a translation:
 * a translation layer is a place for the price to be computed a second way.
 */
export interface MixdownCreditPort {
  /** Requirements 2.9–2.11, without charging. */
  quote(request: {
    readonly assetKind: AssetKind;
    readonly engineId: string;
    readonly durationMs: number;
    readonly outputCount: number;
  }): MixdownCreditQuote;

  /** Requirement 2.7: used here only for its balance, before the render. */
  usage(request: { readonly accountId: string }): Promise<{ readonly balance: number }>;

  /** Requirement 2.12. */
  chargeMixdown(request: {
    readonly accountId: string;
    readonly jobId: string;
    readonly renderDurationMs: number;
  }): Promise<MixdownChargeRecord>;
}
