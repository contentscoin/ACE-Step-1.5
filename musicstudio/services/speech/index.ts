/**
 * Speech_Service (Requirement 25; design §9.2).
 *
 * Implemented here: 25.1–25.23, plus 26.10/26.11's engine binding and 27.14's stored line
 * boundaries.
 *
 * Left to other tasks, as narrow ports rather than stubs:
 * - **tasks 3.1, 5.1** — decoding and the object store, behind `SpeechSynthesisPort` and
 *   `DialogueRenditionStorePort`.
 * - **task 5.3** — Sharing_Service. Nothing in Requirement 25 publishes an asset.
 * - **task 8.x** — design §9.5's "합성 음성" disclosure on a `dialogue` asset.
 *
 * Consumed rather than reimplemented:
 * - **task 6.1** — Requirement 16.11's impersonation block, through the orchestrator's moderation
 *   gate.
 * - **task 6.2** — Requirements 26.18–26.22 and 26.29, through `ProfileAccessService`.
 * - **tasks 2.5/2.6** — the seed derivation of `domain/sfx/seed.ts` and the cross-fade of
 *   `domain/audio/crossfade.ts`.
 */

export type {
  DialogueRendition,
  DialogueRenditionStorePort,
  ReferenceTranscriptionOutcome,
  ReferenceTranscriptionPort,
  ReferenceTranscriptionRequest,
  SpeechFailureRejection,
  SpeechFailureRejectionPort,
  SpeechFailureRejectionResult,
  SpeechSynthesisOutcome,
  SpeechSynthesisPort,
  SpeechSynthesisRequest,
  SynthesisedLine,
} from './ports';
export { SPEECH_FAILURE_CRITERIA, type SpeechFailureCriterion } from './ports';
export {
  dialogueAssetNotFound,
  dialogueGenerationFailed,
  dialogueLanguageUnsupported,
  dialogueLineIndexInvalid,
  dialogueLinesInvalid,
  dialogueRequestInvalid,
  voiceProfileEngineLocked,
  DIALOGUE_LINE_ALLOWANCE,
  DIALOGUE_REQUEST_ALLOWANCE,
} from './speech-errors';
export {
  speechAppliedDefaults,
  type DialogueOutcome,
  type ProducedDialogue,
  type ResynthesisOutcome,
  type ResynthesisedDialogue,
  type SpeechAppliedDefaults,
} from './speech-result';
export {
  SpeechService,
  type DialogueSubmissionInput,
  type LineResynthesisInput,
  type SpeechEngineCapability,
  type SpeechServiceOptions,
} from './speech-service';
