/**
 * Narrow outbound ports of the Provider_Registry.
 *
 * Each port is the seam to a service that task 1.3 does not build:
 *
 * - `EnginePricingPort`  -> Credit_Service unit-price table (task 1.4).
 *   Requirement 20.16/20.17 only require the registry to *check* that an entry
 *   exists, so the port exposes existence and the expected key name, nothing else.
 * - `CreditRefundPort`   -> Credit_Service refund path (task 1.4), used by the
 *   Requirement 20.15 timeout refund.
 * - `AuditSinkPort`      -> Audit_Log writer (task 1.1 owns the table), used by
 *   Requirement 20.20.
 *
 * Keeping them this narrow is what lets 1.3 be tested and merged before 1.4 and
 * 1.5 exist: the fakes in `test/support/` implement three tiny interfaces
 * instead of standing in for two whole services.
 */

import type { AssetKind } from '../../domain/asset-kind';
import type { AuditLogDraft } from '../../domain/audit-log/entry';
import type { EngineAdapter } from '../engine-adapter';

export interface EnginePricingPort {
  /**
   * Pricing is keyed by Asset_Kind x Engine (design §2.4), so a missing entry is
   * reported per key rather than per engine.
   */
  missingPricingKeys(engineId: string, assetKinds: readonly AssetKind[]): readonly string[];
}

/** Accepts every engine; used where pricing is not the subject under test. */
export const permissivePricingPort: EnginePricingPort = {
  missingPricingKeys: () => [],
};

export interface RefundRequest {
  readonly accountId: string;
  readonly jobId: string;
  readonly engineId: string;
  readonly reason: string;
  /** Full amount originally debited — Requirement 20.15 refunds all of it. */
  readonly amount: number;
  /** Requirement 20.15: the refund must land by this instant. */
  readonly refundDeadlineMs: number;
}

export interface CreditRefundPort {
  refund(request: RefundRequest): Promise<void>;
}

export interface AuditSinkPort {
  record(draft: AuditLogDraft): void;
}

/**
 * Resolves the concrete `EngineAdapter` for a descriptor arriving over HTTP.
 *
 * The CRUD API receives a descriptor, not an adapter instance, so registration
 * from the edge needs this indirection. Task 2.1+ supplies the real
 * implementation (ACE / Woosh / TTS / DeepAFx); until then only test doubles
 * are registered, and an unknown engine is rejected rather than guessed at.
 */
export interface EngineAdapterFactoryPort {
  create(descriptor: {
    readonly engineId: string;
    readonly executionLocation: string;
  }): EngineAdapter | undefined;
}

export const noopAuditSink: AuditSinkPort = {
  record: () => undefined,
};
