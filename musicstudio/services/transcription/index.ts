/**
 * Transcription_Service (Requirement 27).
 *
 * Implemented here: 27.1–27.8, 27.10–27.13, 27.15–27.17, and 27.9's timing side.
 *
 * Left to other tasks, as narrow ports rather than stubs:
 * - **task 3.1** — the decoder and the speech-region measurement behind
 *   `TranscriptionAudioProbePort`.
 * - **task 5.1** — Library_Service, behind `TranscriptionStorePort`.
 * - **task 2.3** already owns the LRC printer and parser; 27.10 is satisfied by calling them.
 *
 * Requirement 27.14 is deliberately *not* here: a `dialogue` asset's timings are the boundaries its
 * synthesis confirmed, stored by `services/speech/speech-service.ts`.
 */

export {
  transcriptionEditRejected,
  transcriptionFailed,
  transcriptionNotFound,
  transcriptionRequestInvalid,
  transcriptionTextRejected,
  TRANSCRIPTION_ALLOWANCE,
  TRANSCRIPTION_CONSTRAINTS,
  TRANSCRIPTION_CONSTRAINT_REQUIREMENT,
  type TranscriptionConstraint,
} from './errors';
export type {
  ProbedTranscriptionAudio,
  TranscriptionAudioProbePort,
  TranscriptionEngineOutcome,
  TranscriptionEngineOutput,
  TranscriptionEnginePort,
  TranscriptionEngineRequest,
  TranscriptionProbeOutcome,
  TranscriptionStorePort,
} from './ports';
export {
  TranscriptionService,
  type TranscriptionDownload,
  type TranscriptionRequest,
  type TranscriptionServiceDependencies,
} from './transcription-service';
