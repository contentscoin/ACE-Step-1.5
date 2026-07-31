/**
 * One registered engine's stored state.
 *
 * Two independent flags, because the spec treats them independently:
 *
 * - `activation`   — operator intent. Requirement 20.17 registers an engine
 *   `inactive` when its pricing entry is missing; 20.20 audits deactivation.
 * - `availability` — observed liveness, driven only by health checks
 *   (Requirements 20.8, 20.21).
 *
 * An engine is selectable only when it is active *and* available; collapsing the
 * two would make "deactivated by an operator" indistinguishable from "failing
 * its probe", which Requirement 20.22 has to tell apart in its rejection reason.
 */

import type { EngineAdapter } from '../engine-adapter';

import type { EngineDescriptor } from './engine-descriptor';
import { createHealthHistory, type HealthHistory } from './health-history';
import { initialAvailabilityState, type AvailabilityState } from './health-transitions';
import type { CommercialUseRuling } from './non-commercial-licenses';

export type EngineActivation = 'active' | 'inactive';

export interface EngineRecord {
  readonly descriptor: EngineDescriptor;
  readonly adapter: EngineAdapter;
  readonly activation: EngineActivation;
  readonly availabilityState: AvailabilityState;
  readonly history: HealthHistory;
  /** Ruling in force for this engine (Requirements 33.2, 33.4). */
  readonly commercialUse: CommercialUseRuling;
  readonly registeredAtMs: number;
}

export interface NewEngineRecord {
  readonly descriptor: EngineDescriptor;
  readonly adapter: EngineAdapter;
  readonly activation: EngineActivation;
  readonly commercialUse: CommercialUseRuling;
  readonly registeredAtMs: number;
}

export function createEngineRecord(input: NewEngineRecord): EngineRecord {
  return {
    descriptor: input.descriptor,
    adapter: input.adapter,
    activation: input.activation,
    availabilityState: initialAvailabilityState,
    history: createHealthHistory(),
    commercialUse: input.commercialUse,
    registeredAtMs: input.registeredAtMs,
  };
}

/** Selectable for routing: operator-enabled and passing its probes. */
export function isSelectable(record: EngineRecord): boolean {
  return record.activation === 'active' && record.availabilityState.availability === 'available';
}

/** Snapshot written to the Audit_Log before/after values (Requirement 20.20). */
export interface EngineStateSnapshot {
  readonly activation: EngineActivation;
  readonly availability: AvailabilityState['availability'];
}

export function snapshotOf(record: EngineRecord): EngineStateSnapshot {
  return {
    activation: record.activation,
    availability: record.availabilityState.availability,
  };
}
