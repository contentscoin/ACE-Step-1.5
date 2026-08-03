/**
 * A Persona and its lifecycle (Requirement 15).
 *
 * ```
 *   queued ──start──► training ──complete──► ready ──delete──► deleted
 *      │                  │                    │                  ▲
 *      └────delete────────┴──fail──► failed ───┴──────delete──────┘
 * ```
 *
 * `queued` exists because of the engine, not because of the requirements. The ACE training
 * API is **single-tenant**: `/v1/training/start` answers 400 `Training already in progress`
 * while a run is live, and `/v1/training/status` reports one global run. So a second
 * request cannot start, and the honest thing to report for it under Requirement 15.3 is
 * "waiting", not a step count belonging to somebody else's training. Collapsing `queued`
 * into `training` would make 15.3 report another user's progress as this persona's.
 *
 * `failed` is likewise not in Requirement 15 — 15.1, 15.3 and 15.4 describe the path where
 * training works. A run that dies has to be *somewhere*, and leaving it in `training`
 * forever would make 15.3 report progress that has stopped moving. It is terminal except
 * for deletion, and a new attempt is a new persona rather than a revival, because the
 * reference set may itself be why it failed.
 *
 * Only a `ready` persona is selectable in a generation request (15.5), which is the one
 * transition rule the requirements state outright.
 */

export const PERSONA_STATUSES = ['queued', 'training', 'ready', 'failed', 'deleted'] as const;

export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

export function isPersonaStatus(value: unknown): value is PersonaStatus {
  return typeof value === 'string' && (PERSONA_STATUSES as readonly string[]).includes(value);
}

export interface Persona {
  readonly id: string;
  /** Requirements 15.4, 15.6: a persona belongs to exactly one account, forever. */
  readonly ownerId: string;
  readonly name: string;
  readonly status: PersonaStatus;
  /** The reference songs Requirement 15.1 trained on, in submission order. */
  readonly referenceAssetIds: readonly string[];
  /** The engine's handle for the training run. `null` until it starts. */
  readonly trainingJobId: string | null;
  /**
   * The engine's handle for the trained adapter. `null` until Requirement 15.4 registers it.
   *
   * Opaque on purpose: it is whatever the engine's LoRA registry keys by, and nothing in the
   * product layer parses it. Design §1.4.4 keeps the engine's internals on the far side of
   * the adapter, and a ref this layer could take apart would be a coupling by another name.
   */
  readonly adapterRef: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

const TRANSITIONS: Readonly<Record<PersonaStatus, readonly PersonaStatus[]>> = {
  queued: ['training', 'failed', 'deleted'],
  training: ['ready', 'failed', 'deleted'],
  ready: ['deleted'],
  failed: ['deleted'],
  deleted: [],
};

export function canTransition(from: PersonaStatus, to: PersonaStatus): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Requirement 15.5: only a trained persona can be applied to a generation request. */
export function isSelectable(persona: Persona): boolean {
  return persona.status === 'ready' && persona.adapterRef !== null;
}

/** Requirement 15.3's shape. See `progress.ts` for what fills it. */
export function isTerminal(status: PersonaStatus): boolean {
  return status === 'ready' || status === 'failed' || status === 'deleted';
}
