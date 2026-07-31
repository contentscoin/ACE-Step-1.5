/**
 * Engine routing and single-hop fallback (design §3.3; Requirements 20.3–20.6,
 * 20.10, 20.11, 20.13, 20.22).
 *
 * Two paths that must not be conflated:
 *
 * - **Explicit engine** (20.3): the caller named an engine. Every failure mode
 *   is a rejection. Requirement 20.22 is emphatic that an unavailable or
 *   inactive explicit choice is *not* silently replaced, so no fallback logic is
 *   reachable from this path at all.
 * - **Unspecified engine** (20.4): the kind's default engine is used, and only
 *   here does the 20.10 fallback apply.
 *
 * Requirement 20.10 reads WHERE an alternative is configured / WHILE the default
 * is unavailable / WHEN an engine-less request arrives. That clause order is the
 * evaluation order below: the assignment table decides whether a fallback exists
 * at all, the default engine's state decides whether it is used, and the
 * substitution happens exactly once — a fallback that is itself unusable ends in
 * the 20.11 rejection, never a second hop.
 *
 * Nothing in this module touches credit. That is how "the credit balance is
 * unchanged" (20.11, 20.13, 20.22) holds structurally: routing is decided before
 * any debit, and a rejection is thrown before a caller can reach Credit_Service.
 *
 * Quota is *checked* here and never consumed: the integration point is
 * `registry.quotas.consume`, called by Job_Orchestrator (task 1.5) once a job is
 * actually accepted, so a rejected request leaves both the quota counters and the
 * credit balance exactly as they were.
 */

import type { AssetKind } from '../../domain/asset-kind';

import { isSelectable, type EngineRecord } from './engine-record';
import { supportsAssetKind } from './engine-descriptor';
import {
  assetKindUnsupported,
  engineQuotaExhausted,
  engineUnavailable,
  noAvailableEngine,
  outputDurationExceeded,
  type RegistryError,
} from './errors';
import type { ProviderRegistry } from './provider-registry';
import type { QuotaCheck } from './quota-ledger';

export interface RoutingRequest {
  readonly assetKind: AssetKind;
  readonly durationMs: number;
  /** Present only when the caller named an engine (Requirement 20.3). */
  readonly engineId?: string;
}

export type SubstitutionReason = 'default_engine_unavailable' | 'default_engine_inactive';

export interface RoutingDecision {
  readonly engineId: string;
  readonly record: EngineRecord;
  /** True only on the 20.10 path. */
  readonly substituted: boolean;
  /** Requirement 20.10: the reason travels back with the engine id. */
  readonly substitutionReason?: SubstitutionReason;
  readonly replacedEngineId?: string;
}

/**
 * Resolves the engine for one request, or throws the `RegistryError` whose
 * payload the matching acceptance criterion prescribes.
 */
export function routeGenerationRequest(
  registry: ProviderRegistry,
  request: RoutingRequest,
): RoutingDecision {
  if (request.engineId !== undefined) {
    return routeExplicitEngine(registry, request, request.engineId);
  }
  return routeDefaultEngine(registry, request);
}

/** Requirements 20.3, 20.5, 20.6, 20.13, 20.22 — rejection only, never fallback. */
function routeExplicitEngine(
  registry: ProviderRegistry,
  request: RoutingRequest,
  engineId: string,
): RoutingDecision {
  // Throws `engine_not_found` when the id is unknown.
  const record = registry.require(engineId);

  assertSupportsAssetKind(registry, record, request.assetKind);
  assertDurationWithinLimit(record, request.durationMs);

  const unusable = unusableReason(record);
  if (unusable !== null) {
    throw engineUnavailable(engineId, unusable, availableEngineIds(registry, request.assetKind));
  }

  assertQuotaSufficient(registry, record, request.assetKind);

  return { engineId, record, substituted: false };
}

/** Requirements 20.4, 20.10, 20.11, 20.13. */
function routeDefaultEngine(registry: ProviderRegistry, request: RoutingRequest): RoutingDecision {
  const assignment = registry.assignmentFor(request.assetKind);
  const defaultRecord =
    assignment === undefined ? undefined : registry.find(assignment.defaultEngineId);

  if (assignment === undefined || defaultRecord === undefined) {
    throw noAvailableEngine(request.assetKind, registry.healthSummariesFor(request.assetKind));
  }

  const defaultUnusable = unusableReason(defaultRecord);
  if (defaultUnusable === null) {
    assertSupportsAssetKind(registry, defaultRecord, request.assetKind);
    assertDurationWithinLimit(defaultRecord, request.durationMs);
    assertQuotaSufficient(registry, defaultRecord, request.assetKind);
    return { engineId: defaultRecord.descriptor.engineId, record: defaultRecord, substituted: false };
  }

  // WHERE clause of 20.10: only kinds with a configured alternative re-route.
  const fallbackRecord =
    assignment.fallbackEngineId === undefined
      ? undefined
      : registry.find(assignment.fallbackEngineId);

  if (fallbackRecord === undefined || !isUsableFallback(registry, fallbackRecord, request)) {
    throw noAvailableEngine(request.assetKind, registry.healthSummariesFor(request.assetKind));
  }

  // Exactly one re-route: the fallback is used as-is or the request is rejected.
  return {
    engineId: fallbackRecord.descriptor.engineId,
    record: fallbackRecord,
    substituted: true,
    substitutionReason:
      defaultUnusable === 'unavailable' ? 'default_engine_unavailable' : 'default_engine_inactive',
    replacedEngineId: defaultRecord.descriptor.engineId,
  };
}

/** `null` when the engine may be selected, otherwise why it may not. */
function unusableReason(record: EngineRecord): 'unavailable' | 'inactive' | null {
  if (record.activation !== 'active') return 'inactive';
  if (record.availabilityState.availability !== 'available') return 'unavailable';
  return null;
}

function isUsableFallback(
  registry: ProviderRegistry,
  record: EngineRecord,
  request: RoutingRequest,
): boolean {
  if (!isSelectable(record)) return false;
  if (!supportsAssetKind(record.descriptor, request.assetKind)) return false;
  if (request.durationMs > record.descriptor.maxOutputDurationMs) return false;
  return quotaCheckFor(registry, record).sufficient;
}

/** Requirement 20.5. */
function assertSupportsAssetKind(
  registry: ProviderRegistry,
  record: EngineRecord,
  assetKind: AssetKind,
): void {
  if (supportsAssetKind(record.descriptor, assetKind)) return;
  throw assetKindUnsupported(
    record.descriptor.engineId,
    assetKind,
    registry.enginesSupporting(assetKind).map((candidate) => candidate.descriptor.engineId),
  );
}

/** Requirement 20.6. */
function assertDurationWithinLimit(record: EngineRecord, durationMs: number): void {
  if (durationMs <= record.descriptor.maxOutputDurationMs) return;
  throw outputDurationExceeded(
    record.descriptor.engineId,
    durationMs,
    record.descriptor.maxOutputDurationMs,
  );
}

/** Requirement 20.13. */
function assertQuotaSufficient(
  registry: ProviderRegistry,
  record: EngineRecord,
  assetKind: AssetKind,
): void {
  const check = quotaCheckFor(registry, record);
  if (check.sufficient) return;

  throw engineQuotaExhausted(record.descriptor.engineId, {
    exhausted: check.exhausted,
    nextResetAtMs: check.nextResetAtMs,
    availableEngineIds: availableEngineIds(registry, assetKind).filter(
      (engineId) => engineId !== record.descriptor.engineId,
    ),
  });
}

function quotaCheckFor(registry: ProviderRegistry, record: EngineRecord): QuotaCheck {
  return registry.quotas.check(
    record.descriptor.engineId,
    record.descriptor.dailyQuota,
    registry.quotaRequirementFor(record.descriptor.engineId),
  );
}

function availableEngineIds(registry: ProviderRegistry, assetKind: AssetKind): readonly string[] {
  return registry
    .availableEnginesSupporting(assetKind)
    .map((record) => record.descriptor.engineId);
}

/** Narrows a thrown value to the routing rejection type. */
export type RoutingRejection = RegistryError;
