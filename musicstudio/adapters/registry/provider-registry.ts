/**
 * Provider_Registry (design §3.2–§3.4, Requirements 20.1–20.2, 20.7–20.9,
 * 20.12, 20.16–20.21, 20.23; 33.1–33.6).
 *
 * Owns registration and the stored state of every engine. It deliberately does
 * *not* decide routing (see `routing.ts`) or run the probe loop (see
 * `health-monitor.ts`) — both read this registry, so keeping them separate stops
 * this module from becoming the place every engine concern accumulates.
 */

import { ASSET_KINDS, type AssetKind } from '../../domain/asset-kind';
import { systemClock, type Clock } from '../../services/clock';
import type { EngineAdapter } from '../engine-adapter';

import { engineAuditDraft } from './audit';
import {
  createEngineAssignmentTable,
  type EngineAssignment,
  type EngineAssignmentTable,
} from './default-engines';
import { validateEngineDescriptor } from './descriptor-validation';
import {
  createEngineRecord,
  isSelectable,
  snapshotOf,
  type EngineActivation,
  type EngineRecord,
} from './engine-record';
import { gpuSecondsPerRequest, supportsAssetKind, type EngineDescriptor } from './engine-descriptor';
import {
  defaultEngineInvariantViolated,
  engineAlreadyRegistered,
  engineDescriptorInvalid,
  engineNotFound,
  type EngineHealthSummary,
} from './errors';
import type { HealthCheckRecord } from './health-history';
import { applyHealthOutcome, type AvailabilityTransition } from './health-transitions';
import {
  createNonCommercialLicenseList,
  ruleCommercialUse,
  type NonCommercialLicenseList,
} from './non-commercial-licenses';
import {
  noopAuditSink,
  permissivePricingPort,
  type AuditSinkPort,
  type EnginePricingPort,
} from './ports';
import { createQuotaLedger, type QuotaLedger, type QuotaRequirement } from './quota-ledger';

export interface ProviderRegistryOptions {
  readonly clock?: Clock;
  readonly pricing?: EnginePricingPort;
  readonly auditSink?: AuditSinkPort;
  readonly nonCommercialLicenses?: NonCommercialLicenseList;
  readonly assignments?: EngineAssignmentTable;
}

export interface RegistrationInput {
  readonly descriptor: EngineDescriptor;
  readonly adapter: EngineAdapter;
  readonly actorId: string | null;
}

export interface RegistrationResult {
  readonly engineId: string;
  readonly activation: EngineActivation;
  /** Requirement 20.17: non-empty means the engine was registered inactive. */
  readonly missingPricingKeys: readonly string[];
  /** Requirement 33.2: the recorded permission and, when forced, its grounds. */
  readonly commercialUseAllowed: boolean;
  readonly commercialUseOverridden: boolean;
  readonly groundingLicenseIds: readonly string[];
  readonly nonCommercialLicenseListVersion: number;
}

/** Requirement 20.19 list projection. */
export interface EngineListing {
  readonly engineId: string;
  readonly supportedAssetKinds: readonly AssetKind[];
  readonly maxOutputDurationMs: number;
  readonly commercialUseAllowed: boolean;
  readonly attributionText: string;
  readonly availableNow: boolean;
  readonly lastCheckedAtMs: number | null;
  readonly lastCheckOutcome: 'success' | 'failure' | null;
  readonly activation: EngineActivation;
}

export interface HealthOutcomeRecorded {
  readonly engineId: string;
  readonly transition: AvailabilityTransition;
  readonly record: HealthCheckRecord;
}

export class ProviderRegistry {
  private readonly clock: Clock;
  private readonly pricing: EnginePricingPort;
  private readonly auditSink: AuditSinkPort;
  private readonly assignments: EngineAssignmentTable;
  private readonly records = new Map<string, EngineRecord>();
  private licenseList: NonCommercialLicenseList;
  readonly quotas: QuotaLedger;

  constructor(options: ProviderRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.pricing = options.pricing ?? permissivePricingPort;
    this.auditSink = options.auditSink ?? noopAuditSink;
    this.assignments = options.assignments ?? createEngineAssignmentTable();
    this.licenseList = options.nonCommercialLicenses ?? createNonCommercialLicenseList();
    this.quotas = createQuotaLedger(this.clock);
  }

  get nonCommercialLicenseListVersion(): number {
    return this.licenseList.version;
  }

  /**
   * Requirements 20.1/20.23 (field domains), 20.16/20.17 (pricing entry),
   * 33.2/33.4 (commercial-use ruling), 20.20 (audit).
   *
   * A missing pricing entry is not a rejection: 20.17 says register the engine
   * *inactive* and report the missing key names, which is what the returned
   * `activation` and `missingPricingKeys` express.
   */
  register(input: RegistrationInput): RegistrationResult {
    const invalidFields = validateEngineDescriptor(input.descriptor);
    if (invalidFields.length > 0) throw engineDescriptorInvalid(invalidFields);

    const { descriptor } = input;
    if (this.records.has(descriptor.engineId)) {
      throw engineAlreadyRegistered(descriptor.engineId);
    }

    const missingPricingKeys = this.pricing.missingPricingKeys(
      descriptor.engineId,
      descriptor.supportedAssetKinds,
    );
    const activation: EngineActivation = missingPricingKeys.length === 0 ? 'active' : 'inactive';
    const commercialUse = ruleCommercialUse(
      descriptor.license,
      this.licenseList,
      descriptor.licenseComponents ?? [],
    );
    const registeredAtMs = this.clock.now().getTime();

    const record = createEngineRecord({
      descriptor,
      adapter: input.adapter,
      activation,
      commercialUse,
      registeredAtMs,
    });
    this.records.set(descriptor.engineId, record);

    this.auditSink.record(
      engineAuditDraft({
        change: 'engine_registered',
        engineId: descriptor.engineId,
        actorId: input.actorId,
        before: null,
        after: snapshotOf(record),
        eventTimeMs: registeredAtMs,
      }),
    );

    return {
      engineId: descriptor.engineId,
      activation,
      missingPricingKeys,
      commercialUseAllowed: commercialUse.commercialUseAllowed,
      commercialUseOverridden: commercialUse.overridden,
      groundingLicenseIds: commercialUse.groundingLicenseIds,
      nonCommercialLicenseListVersion: commercialUse.listVersion,
    };
  }

  has(engineId: string): boolean {
    return this.records.has(engineId);
  }

  /** Throws `engine_not_found` rather than returning undefined. */
  require(engineId: string): EngineRecord {
    const record = this.records.get(engineId);
    if (record === undefined) throw engineNotFound(engineId);
    return record;
  }

  find(engineId: string): EngineRecord | undefined {
    return this.records.get(engineId);
  }

  get engineIds(): readonly string[] {
    return [...this.records.keys()];
  }

  /** Replaces the descriptor of a registered engine (CRUD update). */
  update(engineId: string, descriptor: EngineDescriptor, actorId: string | null): EngineRecord {
    const existing = this.require(engineId);
    if (descriptor.engineId !== engineId) {
      throw engineDescriptorInvalid(['engineId']);
    }
    const invalidFields = validateEngineDescriptor(descriptor);
    if (invalidFields.length > 0) throw engineDescriptorInvalid(invalidFields);

    // Requirement 20.2: a default engine must keep supporting its Asset_Kind.
    for (const [assetKind, assignment] of this.assignments) {
      if (assignment.defaultEngineId === engineId && !supportsAssetKind(descriptor, assetKind)) {
        throw defaultEngineInvariantViolated(assetKind, engineId, 'unsupported_asset_kind');
      }
    }

    const commercialUse = ruleCommercialUse(
      descriptor.license,
      this.licenseList,
      descriptor.licenseComponents ?? [],
    );
    const updated: EngineRecord = { ...existing, descriptor, commercialUse };
    this.records.set(engineId, updated);

    // Requirement 33.16: a License_Descriptor change is audited with both values.
    if (!sameLicense(existing.descriptor, descriptor)) {
      this.auditSink.record({
        eventType: 'license_changed',
        actorId,
        targetId: engineId,
        beforeValue: existing.descriptor.license,
        afterValue: descriptor.license,
        eventTime: this.clock.now(),
      });
    }

    return updated;
  }

  /** Requirement 20.20 deactivation event. */
  setActivation(engineId: string, activation: EngineActivation, actorId: string | null): EngineRecord {
    const existing = this.require(engineId);
    if (activation === 'inactive') this.assertNotDefaultEngine(engineId);
    if (existing.activation === activation) return existing;

    const updated: EngineRecord = { ...existing, activation };
    this.records.set(engineId, updated);

    this.auditSink.record(
      engineAuditDraft({
        change: activation === 'inactive' ? 'engine_deactivated' : 'engine_reactivated',
        engineId,
        actorId,
        before: snapshotOf(existing),
        after: snapshotOf(updated),
        eventTimeMs: this.clock.now().getTime(),
      }),
    );

    return updated;
  }

  /** CRUD delete. Refused while the engine is a default (Requirement 20.2). */
  remove(engineId: string, actorId: string | null): void {
    const existing = this.require(engineId);
    this.assertNotDefaultEngine(engineId);
    this.records.delete(engineId);

    this.auditSink.record(
      engineAuditDraft({
        change: 'engine_deactivated',
        engineId,
        actorId,
        before: snapshotOf(existing),
        after: { activation: 'inactive', availability: 'unavailable' },
        eventTimeMs: this.clock.now().getTime(),
      }),
    );
  }

  /**
   * Applies one probe outcome (Requirements 20.7, 20.8, 20.21) and audits the
   * two availability transitions of Requirement 20.20.
   */
  recordHealthOutcome(engineId: string, record: HealthCheckRecord): HealthOutcomeRecorded {
    const existing = this.require(engineId);
    const step = applyHealthOutcome(existing.availabilityState, record.outcome);

    const updated: EngineRecord = {
      ...existing,
      availabilityState: step.state,
      history: existing.history.append(record),
    };
    this.records.set(engineId, updated);

    if (step.transition !== null) {
      this.auditSink.record(
        engineAuditDraft({
          change:
            step.transition === 'became_unavailable'
              ? 'engine_became_unavailable'
              : 'engine_became_available',
          engineId,
          actorId: null,
          before: snapshotOf(existing),
          after: snapshotOf(updated),
          eventTimeMs: record.checkedAtMs,
        }),
      );
    }

    return { engineId, transition: step.transition, record };
  }

  assignmentFor(assetKind: AssetKind): EngineAssignment | undefined {
    return this.assignments.get(assetKind);
  }

  defaultEngineIdFor(assetKind: AssetKind): string | undefined {
    return this.assignments.get(assetKind)?.defaultEngineId;
  }

  /**
   * Requirement 20.2: exactly one default per Asset_Kind, which must support the
   * kind and be active. Requirement 20.20 audits the change.
   */
  setDefaultEngine(assetKind: AssetKind, engineId: string, actorId: string | null): void {
    const record = this.records.get(engineId);
    if (record === undefined) {
      throw defaultEngineInvariantViolated(assetKind, engineId, 'engine_not_found');
    }
    if (!supportsAssetKind(record.descriptor, assetKind)) {
      throw defaultEngineInvariantViolated(assetKind, engineId, 'unsupported_asset_kind');
    }
    if (record.activation !== 'active') {
      throw defaultEngineInvariantViolated(assetKind, engineId, 'engine_inactive');
    }

    const previous = this.assignments.get(assetKind);
    const fallbackEngineId = previous?.fallbackEngineId;
    this.assignments.set(assetKind, {
      defaultEngineId: engineId,
      ...(fallbackEngineId === undefined ? {} : { fallbackEngineId }),
    });

    this.auditSink.record(
      engineAuditDraft({
        change: 'default_engine_changed',
        engineId,
        actorId,
        before: { assetKind, engineId: previous?.defaultEngineId ?? null },
        after: { assetKind, engineId },
        eventTimeMs: this.clock.now().getTime(),
      }),
    );
  }

  /** Engines that support `assetKind`, regardless of state (Requirement 20.5). */
  enginesSupporting(assetKind: AssetKind): readonly EngineRecord[] {
    return [...this.records.values()].filter((record) =>
      supportsAssetKind(record.descriptor, assetKind),
    );
  }

  /** Selectable engines supporting `assetKind` (Requirements 20.11, 20.13, 20.22). */
  availableEnginesSupporting(assetKind: AssetKind): readonly EngineRecord[] {
    return this.enginesSupporting(assetKind).filter(isSelectable);
  }

  /** Requirement 20.11 payload: each candidate's last check time and result. */
  healthSummariesFor(assetKind: AssetKind): readonly EngineHealthSummary[] {
    return this.enginesSupporting(assetKind).map((record) => healthSummaryOf(record));
  }

  /** Requirement 20.19 projection for the engine list query. */
  listEngines(): readonly EngineListing[] {
    return [...this.records.values()].map((record) => {
      const latest = record.history.latest;
      return {
        engineId: record.descriptor.engineId,
        supportedAssetKinds: record.descriptor.supportedAssetKinds,
        maxOutputDurationMs: record.descriptor.maxOutputDurationMs,
        commercialUseAllowed: record.commercialUse.commercialUseAllowed,
        attributionText: record.descriptor.license.attributionText,
        availableNow: isSelectable(record),
        lastCheckedAtMs: latest?.checkedAtMs ?? null,
        lastCheckOutcome: latest?.outcome ?? null,
        activation: record.activation,
      };
    });
  }

  /** GPU seconds and request count one call on `engineId` consumes. */
  quotaRequirementFor(engineId: string): QuotaRequirement {
    const record = this.require(engineId);
    return { requests: 1, gpuSeconds: gpuSecondsPerRequest(record.descriptor) };
  }

  /**
   * Requirement 20.2 as a checkable predicate: every Asset_Kind has exactly one
   * default, and where that engine is registered it supports the kind and is
   * active. Kinds whose default engine is not yet registered are reported so a
   * deployment check can catch them.
   */
  defaultEngineInvariantViolations(): readonly string[] {
    const violations: string[] = [];

    for (const assetKind of ASSET_KINDS) {
      const assignment = this.assignments.get(assetKind);
      if (assignment === undefined) {
        violations.push(`${assetKind}:no_default`);
        continue;
      }
      const record = this.records.get(assignment.defaultEngineId);
      if (record === undefined) {
        violations.push(`${assetKind}:default_not_registered`);
        continue;
      }
      if (!supportsAssetKind(record.descriptor, assetKind)) {
        violations.push(`${assetKind}:default_does_not_support_kind`);
      }
      if (record.activation !== 'active') {
        violations.push(`${assetKind}:default_inactive`);
      }
    }

    return violations;
  }

  /** Requirement 33.3: list edits bump the version by exactly 1. */
  addNonCommercialLicenseId(licenseId: string): number {
    this.licenseList = this.licenseList.add(licenseId);
    return this.licenseList.version;
  }

  removeNonCommercialLicenseId(licenseId: string): number {
    this.licenseList = this.licenseList.remove(licenseId);
    return this.licenseList.version;
  }

  /**
   * Requirement 20.2: a default engine must stay active, so deactivating or
   * deleting one is refused until another engine takes the assignment.
   */
  private assertNotDefaultEngine(engineId: string): void {
    for (const [assetKind, assignment] of this.assignments) {
      if (assignment.defaultEngineId === engineId) {
        throw defaultEngineInvariantViolated(assetKind, engineId, 'engine_is_default');
      }
    }
  }
}

function sameLicense(left: EngineDescriptor, right: EngineDescriptor): boolean {
  return JSON.stringify(left.license) === JSON.stringify(right.license);
}

export function healthSummaryOf(record: EngineRecord): EngineHealthSummary {
  const latest = record.history.latest;
  return {
    engineId: record.descriptor.engineId,
    lastCheckedAtMs: latest?.checkedAtMs ?? null,
    lastCheckOutcome: latest?.outcome ?? null,
  };
}
