/**
 * Persona_Service (Requirement 15, design §3).
 *
 * The engine trains one LoRA at a time, so the queue is here and Requirement 15.3's progress
 * is only read from the engine for the persona the engine is actually running.
 */

export {
  createPersonaService,
  type PersonaAcceptance,
  type PersonaServiceOptions,
} from './persona-service';
export type {
  PersonaAssetLookupPort,
  PersonaAuditPort,
  PersonaRecord,
  PersonaStore,
  PersonaTrainingPort,
  TrainingStartOutcome,
  TrainingStartRequest,
  TrainingStatusReport,
} from './ports';
export {
  personaForbidden,
  personaNotFound,
  personaNotReady,
  personaReferenceInvalid,
  personaRequestInvalid,
} from './errors';
