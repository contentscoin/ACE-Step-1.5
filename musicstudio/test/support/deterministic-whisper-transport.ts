/**
 * A Whisper deployment, simulated in memory (Requirement 27; design §13).
 *
 * **No speech-recognition service is reachable from this environment**, so this is what the
 * adapter is exercised against. As with `deterministic-tts-transport.ts`, it is a *function of the
 * wire payload* rather than a stub returning a canned answer, because the two things worth
 * checking about this adapter are both properties of the translation:
 *
 * - a request carrying a language hint must come back with that code and **no** confidence;
 * - segment boundaries in floating-point seconds must become the integer milliseconds Requirement
 *   27.1 asks for, with the rounding `wire.ts` specifies.
 *
 * Neither is observable against a simulator that ignores what it was sent. So the segments here
 * are derived from the payload — the audio's declared duration decides how many there are and how
 * long each is — and the language echo follows the same rule a real server does: a hinted run
 * still reports a probability, which is exactly the case the adapter has to discard.
 *
 * Nothing here reads a clock or a random source.
 */

import type {
  TranscriptionJsonRequest,
  TranscriptionJsonResponse,
  TranscriptionTransport,
} from '../../adapters/transcription/transport';

export interface DeterministicWhisperTransport extends TranscriptionTransport {
  /** Every request the adapter sent, so a test can assert on the wire form. */
  readonly requests: readonly TranscriptionJsonRequest[];
  /** Answer the next call with this HTTP status instead of 200. */
  failNextWithStatus(status: number): void;
  /** Answer the next call 200 with this body — for malformed and error envelopes. */
  answerNextWith(body: unknown): void;
  /** Throw from the next call, as a socket reset would. */
  throwNext(message?: string): void;
  /** Segments the simulator reports, in seconds. Defaults to a duration-derived list. */
  setSegments(segments: readonly { start: number; end: number; text: string }[]): void;
  setLanguage(language: string, probability: number | null): void;
}

/** Segment length the default answer uses, in seconds. Ends on a fractional millisecond. */
const SEGMENT_SECONDS = 1.2345;

export function deterministicWhisperTransport(): DeterministicWhisperTransport {
  const requests: TranscriptionJsonRequest[] = [];
  let statusOverride: number | null = null;
  let bodyOverride: { value: unknown } | null = null;
  let throwMessage: string | null = null;
  let segments: readonly { start: number; end: number; text: string }[] | null = null;
  let language = 'en';
  let languageProbability: number | null = 0.93;

  /** Segments derived from the declared duration, so a longer file really has more lines. */
  function defaultSegments(durationMs: number): { start: number; end: number; text: string }[] {
    const count = Math.max(1, Math.floor(durationMs / 1000 / SEGMENT_SECONDS));
    return Array.from({ length: count }, (_unused, index) => ({
      start: index * SEGMENT_SECONDS,
      end: (index + 1) * SEGMENT_SECONDS,
      // The leading space a real server emits, so the adapter's trim is exercised.
      text: ` line ${String(index + 1)}`,
    }));
  }

  return {
    requests,
    failNextWithStatus: (status) => {
      statusOverride = status;
    },
    answerNextWith: (body) => {
      bodyOverride = { value: body };
    },
    throwNext: (message = 'socket hang up') => {
      throwMessage = message;
    },
    setSegments: (next) => {
      segments = next;
    },
    setLanguage: (code, probability) => {
      language = code;
      languageProbability = probability;
    },

    requestJson: async (request): Promise<TranscriptionJsonResponse> => {
      requests.push(request);

      if (throwMessage !== null) {
        const message = throwMessage;
        throwMessage = null;
        throw new Error(message);
      }
      if (statusOverride !== null) {
        const httpStatus = statusOverride;
        statusOverride = null;
        return { httpStatus, body: { error: 'engine said no' } };
      }
      if (bodyOverride !== null) {
        const { value } = bodyOverride;
        bodyOverride = null;
        return { httpStatus: 200, body: value };
      }

      const audio = (request.body?.['audio'] ?? {}) as Record<string, unknown>;
      const durationMs = typeof audio['duration_ms'] === 'number' ? audio['duration_ms'] : 0;
      const hinted = request.body?.['language'];

      return {
        httpStatus: 200,
        body: {
          // A real server echoes the hint it was given, and still scores it — which is the case
          // the adapter must not report as a detection.
          language: typeof hinted === 'string' ? hinted : language,
          language_probability: languageProbability,
          duration: durationMs / 1000,
          segments: segments ?? defaultSegments(durationMs),
        },
      };
    },
  };
}
