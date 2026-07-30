/**
 * Audit drafts for the five Provider_Registry events of Requirement 20.20:
 * registration, deactivation, transition to unavailable, recovery to available,
 * and default-engine change.
 *
 * All five reuse the existing `engine_state_changed` event type from
 * `domain/audit-log/entry.ts` — the enum and its SQL counterpart are task 1.1's,
 * and adding members would mean a migration for no gain. The specific event is
 * carried by the `change` discriminator that appears in both the before and the
 * after value, alongside the required event time, actor and target.
 */

import { buildAuditLogEntry, type AuditLogDraft } from '../../domain/audit-log/entry';

import type { EngineStateSnapshot } from './engine-record';

export type EngineAuditChange =
  | 'engine_registered'
  | 'engine_deactivated'
  | 'engine_reactivated'
  | 'engine_became_unavailable'
  | 'engine_became_available'
  | 'default_engine_changed';

export interface EngineAuditInput {
  readonly change: EngineAuditChange;
  readonly engineId: string;
  /** Operator or system actor; `null` for automated health transitions. */
  readonly actorId: string | null;
  readonly before: EngineStateSnapshot | DefaultEngineSnapshot | null;
  readonly after: EngineStateSnapshot | DefaultEngineSnapshot;
  readonly eventTimeMs: number;
}

export interface DefaultEngineSnapshot {
  readonly assetKind: string;
  readonly engineId: string | null;
}

export function engineAuditDraft(input: EngineAuditInput): AuditLogDraft {
  return {
    eventType: 'engine_state_changed',
    actorId: input.actorId,
    targetId: input.engineId,
    beforeValue: input.before === null ? null : { change: input.change, state: input.before },
    afterValue: { change: input.change, state: input.after },
    eventTime: new Date(input.eventTimeMs),
  };
}

/** Convenience for callers that want the built entry rather than the draft. */
export function engineAuditEntry(input: EngineAuditInput) {
  return buildAuditLogEntry(engineAuditDraft(input), new Date(input.eventTimeMs));
}
