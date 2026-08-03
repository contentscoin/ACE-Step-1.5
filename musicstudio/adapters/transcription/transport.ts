/**
 * The HTTP seam to a speech-recognition deployment (design §1.4.4, §13's Whisper_Adapter).
 *
 * The adapter never calls `fetch`; it calls this port, for the reason every other adapter folder
 * here gives — the wire payload becomes an assertable value and no test needs a running model.
 *
 * **No speech-recognition service is reachable from this environment.** The envelope
 * `whisper-adapter.ts` decodes is the one a self-hosted `faster-whisper` / `whisper.cpp` server
 * emits — `{ language, language_probability, duration, segments: [{ start, end, text }] }`, with
 * times in **seconds** — and it is **unverified against a real deployment**. That is the thing to
 * confirm before pointing the adapter at a live engine: a §14 risk to settle with whoever owns it.
 * What is settled is that the adapter implements `TranscriptionEnginePort` and nothing else, so a
 * different envelope is a change confined to this folder.
 *
 * ### Why the audio is a reference and not bytes
 *
 * `requestJson` carries an object reference, not a multipart upload. The audio is already in the
 * object store the Transcription_Service probed (Requirement 27.5's measurements come from there),
 * and streaming a 500 MB file through the product layer to hand it to a service that can read the
 * same bucket would double the transfer for no gain. The same shape `adapters/deepafx` uses.
 */

export interface TranscriptionJsonRequest {
  /** Engine path, e.g. `/v1/audio/transcriptions`. */
  readonly path: string;
  readonly method?: 'POST' | 'GET';
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface TranscriptionJsonResponse {
  readonly httpStatus: number;
  /** Parsed body. Shape is the engine's own; the adapter decodes it. */
  readonly body: unknown;
}

export interface TranscriptionTransport {
  requestJson(request: TranscriptionJsonRequest): Promise<TranscriptionJsonResponse>;
}

export interface TranscriptionHttpTransportConfig {
  /** Engine origin, e.g. `http://asr.internal:9000`. No trailing slash needed. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer …`, so a credential never appears in a payload. */
  readonly apiToken?: string;
  /** Injected so the production transport is testable without a global stub. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Production transport over `fetch`.
 *
 * No timeout of its own. Requirement 27.1's deadline is `audio seconds × the tier's declared
 * cost + 60 s` and the Transcription_Service enforces exactly that (`hasExceededBudget`); a
 * second, quieter deadline here would make the effective budget unknowable and could fail a
 * transcription the advertised contract still permitted.
 *
 * A body that is not JSON is reported as `httpStatus` with `body: null` rather than thrown, so an
 * engine answering HTML from a proxy becomes Requirement 27.16's failure path instead of an
 * exception the service never sees.
 */
export function createTranscriptionHttpTransport(
  config: TranscriptionHttpTransportConfig,
): TranscriptionTransport {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const origin = config.baseUrl.replace(/\/+$/, '');

  return {
    async requestJson(request) {
      const method = request.method ?? 'POST';
      const response = await fetchImpl(`${origin}${request.path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(config.apiToken === undefined
            ? {}
            : { authorization: `Bearer ${config.apiToken}` }),
        },
        ...(method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });

      const body: unknown = await response.json().catch(() => null);
      return { httpStatus: response.status, body };
    },
  };
}
