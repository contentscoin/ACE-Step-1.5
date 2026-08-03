/**
 * The seams around `Persona_Service` (Requirement 15, design §3).
 *
 * ### The engine's training API is single-tenant, and the port says so
 *
 * ACE's `/v1/training/start` refuses with 400 `Training already in progress` while a run is
 * live, and `/v1/training/status` reports **one** global run with no job identifier to
 * select by. That is not an implementation detail this layer can paper over: it decides
 * what Requirement 15.3 can honestly report for a persona that is not the running one, and
 * it means the queue is the product layer's job.
 *
 * So `PersonaTrainingPort` mirrors the engine's real shape — `start` may refuse as busy,
 * `status` describes whatever is currently running — and the service owns the queue,
 * matching a status report to a persona only when that persona is the one running. A port
 * that pretended to take a job id would be a lie the first time two users trained at once.
 *
 * ### The adapter reference is opaque
 *
 * Whatever the engine's LoRA registry keys by. Nothing here parses it; design §1.4.4 keeps
 * the engine's internals on the far side of the adapter.
 */

import type { TrainingStage } from '../../domain/persona/progress';
import type { Persona, PersonaStatus } from '../../domain/persona/persona';

export interface PersonaRecord extends Persona {
  readonly rightsConfirmedAtMs: number;
}

export interface PersonaStore {
  insert(record: PersonaRecord): Promise<void>;
  find(personaId: string): Promise<PersonaRecord | null>;
  update(record: PersonaRecord): Promise<void>;
  listByOwner(ownerId: string): Promise<readonly PersonaRecord[]>;
  /** Requirement 15.3's queue position, and who the engine should train next. */
  listByStatus(status: PersonaStatus): Promise<readonly PersonaRecord[]>;
}

/** Requirement 15.1 — the reference songs must exist and be the requester's. */
export interface PersonaAssetLookupPort {
  ownerOf(assetId: string): Promise<string | null>;
}

export interface TrainingStartRequest {
  readonly personaId: string;
  readonly referenceAssetIds: readonly string[];
}

export type TrainingStartOutcome =
  | { readonly kind: 'started'; readonly trainingJobId: string; readonly totalSteps: number | null }
  /** The engine is training something else. The service queues and retries. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'refused'; readonly reason: string };

/** What `/v1/training/status` reports, narrowed to what Requirement 15.3 needs. */
export interface TrainingStatusReport {
  readonly isTraining: boolean;
  /** Which run this describes. `null` when the engine reports no identifier. */
  readonly trainingJobId: string | null;
  readonly stage: TrainingStage;
  readonly currentStep: number | null;
  readonly totalSteps: number | null;
  readonly estimatedSecondsRemaining: number | null;
  readonly error: string | null;
}

export interface PersonaTrainingPort {
  start(request: TrainingStartRequest): Promise<TrainingStartOutcome>;
  /** The engine's *current* run, whichever persona it belongs to. See the header. */
  status(): Promise<TrainingStatusReport>;
  /** Requirement 15.4 — export the trained weights and register them as an adapter. */
  exportAdapter(personaId: string): Promise<string>;
  /** Requirement 15.7 — remove the adapter so nothing can load it again. */
  deleteAdapter(adapterRef: string): Promise<void>;
}

/**
 * Requirement 15.8's consent record, in the Audit_Log.
 *
 * `consent_recorded` — the member design §4.4 already lists — rather than a new
 * `persona_trained` event. Requirement 15 asks for the consent to be *stored*, which the
 * `persona.rights_confirmed_at` column does; the audit entry is the same fact in the
 * append-only record that Requirement 16.14 and design §4.4 keep for exactly this class of
 * assertion. No criterion in 15 asks for an event on deletion, so there is none.
 */
export interface PersonaAuditPort {
  record(event: {
    readonly eventType: 'consent_recorded';
    readonly actorId: string;
    readonly targetId: string;
    readonly atMs: number;
  }): Promise<void>;
}
