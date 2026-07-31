/**
 * The HTTP seam to a TTS deployment (design §1.4.4).
 *
 * Neither TTS adapter calls `fetch`; both call this port, for the two reasons
 * `adapters/ace/transport.ts` and `adapters/woosh/transport.ts` give — the wire payload becomes
 * an assertable value, and no test needs a running engine.
 *
 * The second reason is not a convenience here. **No TTS service is reachable from this
 * environment**, so every statement this repository makes about either engine's wire form is a
 * statement about what *would* be sent, checked against a deterministic in-memory transport
 * (`test/support/deterministic-tts-transport.ts`). Both envelope shapes below are therefore
 * **unverified against a real deployment** and are the thing to confirm before either adapter is
 * pointed at a live engine: a §14 risk to settle with whoever owns the deployments.
 *
 * What *is* settled, and what the rest of the system depends on, is that both adapters implement
 * `EngineAdapter` and nothing else — so if an envelope turns out to differ, the change is
 * confined to this folder.
 *
 * ### One transport port, two protocols
 *
 * Requirement 25.2 asks for two or more engines, and design §3.6 names two. They are genuinely
 * different services, not one service with a flag: engine A speaks a wrapped JSON envelope with
 * numeric task states, engine B a flat REST body with string states and a per-utterance download
 * route. That difference is the whole point of the abstraction, so it is preserved rather than
 * smoothed away — the transport carries bytes and status codes, and each adapter owns its own
 * translation.
 */

export interface TtsJsonRequest {
  /** Engine path, e.g. `/v1/tts/submit`. */
  readonly path: string;
  readonly method?: 'POST' | 'GET';
  readonly body?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, string>>;
}

export interface TtsJsonResponse {
  readonly httpStatus: number;
  /** Parsed body. Shape is the engine's own; each adapter decodes its own. */
  readonly body: unknown;
}

export interface TtsBinaryRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
}

export interface TtsBinaryResponse {
  readonly httpStatus: number;
  readonly body: Buffer;
}

export interface TtsTransport {
  requestJson(request: TtsJsonRequest): Promise<TtsJsonResponse>;
  requestBinary(request: TtsBinaryRequest): Promise<TtsBinaryResponse>;
}

export interface TtsHttpTransportConfig {
  /** Engine origin, e.g. `http://tts-a.internal:8200`. No trailing slash needed. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer …`, so a credential never appears in a payload. */
  readonly apiToken?: string;
  /** Injected so the production transport is testable without a global stub. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Production transport over `fetch`.
 *
 * No timeout of its own: Requirement 20.14's 300-second cap is applied by `callRemoteEngine`
 * around the whole adapter call, and a second, quieter deadline here would make the effective
 * budget unknowable. The same reasoning `adapters/woosh/transport.ts` records.
 */
export function createTtsHttpTransport(config: TtsHttpTransportConfig): TtsTransport {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const origin = config.baseUrl.replace(/\/+$/, '');

  const authHeaders = (): Record<string, string> =>
    config.apiToken === undefined ? {} : { authorization: `Bearer ${config.apiToken}` };

  const suffixOf = (query: Readonly<Record<string, string>> | undefined): string => {
    if (query === undefined) return '';
    const encoded = new URLSearchParams(query).toString();
    return encoded === '' ? '' : `?${encoded}`;
  };

  return {
    async requestJson(request) {
      const method = request.method ?? 'POST';
      const response = await fetchImpl(`${origin}${request.path}${suffixOf(request.query)}`, {
        method,
        headers: { 'content-type': 'application/json', ...authHeaders() },
        ...(method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      return { httpStatus: response.status, body: await response.json() };
    },

    async requestBinary(request) {
      const response = await fetchImpl(`${origin}${request.path}${suffixOf(request.query)}`, {
        method: 'GET',
        headers: authHeaders(),
      });
      return { httpStatus: response.status, body: Buffer.from(await response.arrayBuffer()) };
    },
  };
}
