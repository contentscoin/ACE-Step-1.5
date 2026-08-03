/**
 * Persona_Service — LoRA training, progress, adapter resolution and deletion.
 *
 * Requirements 15.1–15.8, design §3.
 *
 * ### The queue exists because the engine has one slot
 *
 * `/v1/training/start` answers 400 while a run is live and `/v1/training/status` reports one
 * global run (see `ports.ts`). Two consequences run through everything below:
 *
 * 1. **A request always succeeds in being accepted.** Requirement 15.1 returns 학습 작업
 *    식별자, and refusing the eighth user because the first is training would make that
 *    identifier a lottery ticket. A persona that cannot start now is `queued`, and
 *    `pumpQueue` starts it when the engine frees up.
 * 2. **Progress is only reported from the engine for the persona actually running.** For a
 *    queued one, Requirement 15.3's "현재 학습 단계" is `queued` with its position, which is
 *    true, rather than the running persona's step count, which would be a different user's
 *    work displayed as this user's.
 *
 * `pumpQueue` is called by the service after every state change and is safe to call from a
 * timer as well; it is idempotent and starts at most one run.
 */

import { randomUUID } from 'node:crypto';

import {
  canTransition,
  isSelectable,
  type Persona,
  type PersonaStatus,
} from '../../domain/persona/persona';
import { progressFraction, stageForStatus, type TrainingProgress } from '../../domain/persona/progress';
import {
  distinctReferences,
  personaRequestViolations,
  type PersonaTrainingRequestInput,
} from '../../domain/persona/training-request';
import { systemClock, type Clock } from '../clock';
import {
  personaForbidden,
  personaNotFound,
  personaNotReady,
  personaReferenceInvalid,
  personaRequestInvalid,
} from './errors';
import type {
  PersonaAssetLookupPort,
  PersonaAuditPort,
  PersonaRecord,
  PersonaStore,
  PersonaTrainingPort,
} from './ports';

export interface PersonaServiceOptions {
  readonly personas: PersonaStore;
  readonly training: PersonaTrainingPort;
  readonly assets: PersonaAssetLookupPort;
  readonly clock?: Clock;
  readonly generateId?: () => string;
  /** Requirement 15.8's consent record, in the append-only log. */
  readonly audit?: PersonaAuditPort;
}

export interface PersonaAcceptance {
  readonly persona: PersonaRecord;
  /** Requirement 15.1's 학습 작업 식별자. The persona id: one request, one persona, one run. */
  readonly trainingJobId: string;
  readonly queuePosition: number;
}

export function createPersonaService(options: PersonaServiceOptions) {
  const { personas, training, assets } = options;
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? randomUUID;
  const audit = options.audit;

  function nowMs(): number {
    return clock.now().getTime();
  }

  async function loadOwned(personaId: string, requesterId: string): Promise<PersonaRecord> {
    const persona = await personas.find(personaId);
    // Requirement 15.7: a deleted persona is "선택 불가", which is not distinguishable from
    // never having existed as far as any later request is concerned.
    if (persona === null || persona.status === 'deleted') throw personaNotFound(personaId);
    if (persona.ownerId !== requesterId) throw personaForbidden(personaId);
    return persona;
  }

  async function moveTo(persona: PersonaRecord, status: PersonaStatus, patch: Partial<PersonaRecord> = {}): Promise<PersonaRecord> {
    if (!canTransition(persona.status, status)) return persona;
    const next: PersonaRecord = { ...persona, ...patch, status, updatedAtMs: nowMs() };
    await personas.update(next);
    return next;
  }

  /** Start the next queued persona if the engine is free. Idempotent; safe to over-call. */
  async function pumpQueue(): Promise<void> {
    const running = await personas.listByStatus('training');
    if (running.length > 0) return;

    const queued = [...(await personas.listByStatus('queued'))].sort(
      (left, right) => left.createdAtMs - right.createdAtMs,
    );
    const next = queued[0];
    if (next === undefined) return;

    const outcome = await training.start({
      personaId: next.id,
      referenceAssetIds: next.referenceAssetIds,
    });

    // `busy` leaves it queued: the engine took a run from somewhere else between the check
    // above and this call, and the next pump will find it.
    if (outcome.kind === 'busy') return;
    if (outcome.kind === 'refused') {
      await moveTo(next, 'failed');
      return;
    }
    await moveTo(next, 'training', { trainingJobId: outcome.trainingJobId });
  }

  return {
    /** Requirements 15.1, 15.2, 15.8. */
    async requestTraining(input: PersonaTrainingRequestInput): Promise<PersonaAcceptance> {
      const violations = personaRequestViolations(input);
      if (violations.length > 0) throw personaRequestInvalid(violations);

      const references = distinctReferences(input.referenceAssetIds);
      // Requirement 15.1's 참조 곡 are the requester's own. Checked before anything is
      // stored, so a refused request leaves no persona behind.
      const foreign: string[] = [];
      for (const assetId of references) {
        if ((await assets.ownerOf(assetId)) !== input.ownerId) foreign.push(assetId);
      }
      if (foreign.length > 0) throw personaReferenceInvalid(foreign);

      const at = nowMs();
      const persona: PersonaRecord = {
        id: generateId(),
        ownerId: input.ownerId,
        name: input.name.trim(),
        status: 'queued',
        referenceAssetIds: references,
        trainingJobId: null,
        adapterRef: null,
        createdAtMs: at,
        updatedAtMs: at,
        // Validated above: `personaRequestViolations` refuses an absent or negative consent,
        // so by here there is one.
        rightsConfirmedAtMs: input.consent?.confirmedAtMs ?? at,
      };
      await personas.insert(persona);

      await audit?.record({
        eventType: 'consent_recorded',
        actorId: input.ownerId,
        targetId: persona.id,
        atMs: at,
      });

      await pumpQueue();

      const stored = (await personas.find(persona.id)) ?? persona;
      return {
        persona: stored,
        trainingJobId: persona.id,
        queuePosition: await queuePositionOf(stored),
      };
    },

    /** Requirement 15.3 — the stage and the progress, honestly attributed. */
    async progress(personaId: string, requesterId: string): Promise<TrainingProgress> {
      const persona = await loadOwned(personaId, requesterId);
      const position = await queuePositionOf(persona);

      if (persona.status !== 'training') {
        return {
          stage: stageForStatus(persona.status),
          fraction: persona.status === 'ready' ? 1 : null,
          currentStep: null,
          totalSteps: null,
          queuePosition: position,
          estimatedSecondsRemaining: null,
        };
      }

      const report = await training.status();
      // The engine reports one run. If it is not this persona's, this persona is between
      // states — report the stage its own record implies rather than someone else's numbers.
      const mine =
        report.trainingJobId === null || report.trainingJobId === persona.trainingJobId;
      if (!mine) {
        return {
          stage: 'training',
          fraction: null,
          currentStep: null,
          totalSteps: null,
          queuePosition: position,
          estimatedSecondsRemaining: null,
        };
      }

      return {
        stage: report.stage,
        fraction: progressFraction(report.currentStep, report.totalSteps),
        currentStep: report.currentStep,
        totalSteps: report.totalSteps,
        queuePosition: position,
        estimatedSecondsRemaining: report.estimatedSecondsRemaining,
      };
    },

    /**
     * Requirement 15.4 — training finished; register the adapter as the owner's persona.
     *
     * Called by whoever observes completion (a poller over `training.status()`), not by the
     * engine: nothing in this layer is reachable from the engine, and design §1.4.4 keeps it
     * that way.
     */
    async completeTraining(personaId: string): Promise<PersonaRecord> {
      const persona = await personas.find(personaId);
      if (persona === null) throw personaNotFound(personaId);

      const adapterRef = await training.exportAdapter(personaId);
      const ready = await moveTo(persona, 'ready', { adapterRef });
      await pumpQueue();
      return ready;
    },

    async failTraining(personaId: string): Promise<PersonaRecord> {
      const persona = await personas.find(personaId);
      if (persona === null) throw personaNotFound(personaId);
      const failed = await moveTo(persona, 'failed');
      await pumpQueue();
      return failed;
    },

    /**
     * Requirements 15.5, 15.6 — the adapter for a generation request, or a refusal.
     *
     * The whole surface the Generation_Gateway needs, and the reason it is a function on
     * this service rather than a lookup in the gateway: 15.6's ownership check and 15.5's
     * readiness check are one decision, and a gateway that fetched a persona and read its
     * fields would be re-deriving it.
     */
    async resolveAdapter(personaId: string, requesterId: string): Promise<string> {
      const persona = await loadOwned(personaId, requesterId);
      if (!isSelectable(persona)) throw personaNotReady(personaId, persona.status);
      // `isSelectable` already proved this is non-null; the assertion is for the type.
      return persona.adapterRef ?? '';
    },

    /** Requirement 15.7 — the adapter is removed and the persona becomes unselectable. */
    async remove(personaId: string, requesterId: string): Promise<PersonaRecord> {
      const persona = await loadOwned(personaId, requesterId);
      if (persona.adapterRef !== null) await training.deleteAdapter(persona.adapterRef);
      // The ref is cleared in the same write that marks it deleted — `persona_deleted_has_no_
      // adapter` in 0017_sharing.sql refuses the alternative, so a deleted persona can never
      // name an adapter something else could load.
      const deleted = await moveTo(persona, 'deleted', { adapterRef: null });
      await pumpQueue();
      return deleted;
    },

    async list(ownerId: string): Promise<readonly PersonaRecord[]> {
      const owned = await personas.listByOwner(ownerId);
      return owned.filter((persona) => persona.status !== 'deleted');
    },

    /** Exposed so a scheduler can drive the queue without reaching into the internals. */
    pumpQueue,
  };

  async function queuePositionOf(persona: Persona): Promise<number> {
    if (persona.status !== 'queued') return 0;
    const queued = [...(await personas.listByStatus('queued'))].sort(
      (left, right) => left.createdAtMs - right.createdAtMs,
    );
    const index = queued.findIndex((candidate) => candidate.id === persona.id);
    return index < 0 ? 0 : index + 1;
  }
}
