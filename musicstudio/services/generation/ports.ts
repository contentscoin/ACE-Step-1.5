/**
 * Narrow outbound ports of the Job_Orchestrator.
 *
 * Each one is the seam to a service this task does not build, following the same
 * shape as `adapters/registry/ports.ts`:
 *
 * - `CreditChargePort`      -> Credit_Service debit (task 1.4). Only the amount
 *   comes back, because that amount is all Requirements 5.7/5.8/6.3 need in order
 *   to refund. Refunds go through the existing `CreditRefundPort` in
 *   `adapters/registry/ports.ts` rather than a second refund path, so the
 *   Requirement 20.15 refund and the Requirement 5.8 refund are the same call.
 * - `AssetPublicationPort`  -> Library_Service (task 5.1), for Requirement 5.6.
 * - `EngineStatisticsPort`  -> the engine's reported average duration, which
 *   Requirement 5.5 makes an input to the ETA. Reported by the engine, so it is
 *   read through a port rather than measured here.
 *
 * Keeping these separate from the registry ports means task 1.5 depends on two
 * tiny interfaces from task 1.4's direction, not on Credit_Service itself.
 */

import type { NormalizedGenerationResult } from '../../adapters/normalized-generation';
import type { AssetKind } from '../../domain/asset-kind';

export interface ChargeRequest {
  readonly accountId: string;
  readonly jobId: string;
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly durationMs: number;
  /** Number of audio results requested; the `batch_size` of Requirement 2.2. */
  readonly resultCount: number;
}

export interface ChargeOutcome {
  /** Credits actually debited. The full amount a later refund returns. */
  readonly debitedAmount: number;
}

export interface CreditChargePort {
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
}

/**
 * Charges nothing.
 *
 * The default for compositions that do not yet include Credit_Service. It is not
 * a silent bypass: a debit of 0 refunds 0, so the refund paths stay consistent,
 * and swapping in the real service changes only the amount.
 */
export const freeChargePort: CreditChargePort = {
  charge: async () => ({ debitedAmount: 0 }),
};

export interface AssetPublicationRequest {
  readonly accountId: string;
  readonly jobId: string;
  readonly assetKind: AssetKind;
  readonly engineId: string;
  /** Requirement 5.6: one Audio_Asset is created per entry. */
  readonly results: readonly NormalizedGenerationResult[];
}

export interface AssetPublicationPort {
  /** Returns the created Audio_Asset identifiers, in result order. */
  publish(request: AssetPublicationRequest): Promise<readonly string[]>;
}

export interface EngineStatisticsPort {
  /** Average duration the engine reports, or `null` when it reports none. */
  averageDurationMs(engineId: string): number | null;
}

export const noEngineStatistics: EngineStatisticsPort = {
  averageDurationMs: () => null,
};
