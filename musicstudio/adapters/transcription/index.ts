/**
 * Transcription_Adapter (design §13, Requirement 27).
 *
 * One implementation of `services/transcription/ports.ts`'s `TranscriptionEnginePort`, over the
 * envelope a self-hosted Whisper-family server emits. Thin on purpose: the invariants, the
 * deadline, the validation and the no-speech path all live above it.
 */

export {
  WHISPER_TRANSCRIPTION_PATH,
  WHISPER_TRANSCRIPTION_TIERS,
  areWhisperTiersWellFormed,
  createWhisperTranscriptionAdapter,
  type WhisperAdapterOptions,
} from './whisper-adapter';
export {
  createTranscriptionHttpTransport,
  type TranscriptionHttpTransportConfig,
  type TranscriptionJsonRequest,
  type TranscriptionJsonResponse,
  type TranscriptionTransport,
} from './transport';
export {
  decodeWhisperResponse,
  languageOf,
  linesFromSegments,
  secondsToMs,
  type WhisperResponse,
  type WhisperSegment,
} from './wire';
