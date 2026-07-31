/**
 * TTS adapter failures.
 *
 * The same two-error vocabulary `adapters/woosh/errors.ts` uses, and for the same reason: an
 * adapter has exactly two ways to fail that are its own business — the engine answered something
 * it cannot decode, or it answered about a task it does not know. Everything else (a timeout, a
 * retry, a refund) belongs to the Job_Orchestrator, and raising an adapter-specific error for any
 * of those would create a second path through the lifecycle.
 */

export type TtsErrorCode = 'tts_malformed_response' | 'tts_task_unknown';

export class TtsAdapterError extends Error {
  readonly code: TtsErrorCode;
  readonly path: string;

  constructor(code: TtsErrorCode, path: string, message: string) {
    super(message);
    this.name = 'TtsAdapterError';
    this.code = code;
    this.path = path;
  }
}

export function ttsMalformedResponse(path: string, detail: string): TtsAdapterError {
  return new TtsAdapterError(
    'tts_malformed_response',
    path,
    `the TTS engine's response to ${path} could not be read: ${detail}`,
  );
}

export function ttsTaskUnknown(path: string, engineJobId: string): TtsAdapterError {
  return new TtsAdapterError(
    'tts_task_unknown',
    path,
    `the TTS engine does not know task ${engineJobId}`,
  );
}
