/**
 * The HTTP seam to ACE-Step (design §1.4.4).
 *
 * `ACE_Engine_Adapter` never calls `fetch` directly; it calls this port. Two
 * consequences, both wanted:
 *
 * - The wire payload becomes an assertable value. A test can read exactly what
 *   would have been posted, which is how Requirements 3.1–3.3 and 4.1–4.10 are
 *   verified — each of them is a statement about a field on the wire.
 * - No test needs a running engine. The engine is a separate deployment
 *   (design §1.4.1) and is not available in CI.
 *
 * The port is deliberately dumb: it moves JSON and bytes and reports transport
 * failure. Envelope decoding, status mapping and payload construction all live in
 * their own modules.
 */

/**
 * The response envelope every ACE-Step JSON route returns.
 *
 * `{ data, code, error, timestamp, extra }` — `code` is an application-level
 * status that is *not* the HTTP status, so a 200 response can still carry
 * `code: 500`. `decodeEnvelope` is what enforces that distinction.
 */
export interface AceEnvelope {
  readonly data: unknown;
  readonly code?: unknown;
  readonly error?: unknown;
  readonly timestamp?: unknown;
  readonly extra?: unknown;
}

export interface AceJsonRequest {
  /** Engine path, e.g. `/release_task`. */
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface AceJsonResponse {
  readonly httpStatus: number;
  readonly envelope: AceEnvelope;
}

export interface AceBinaryRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface AceBinaryResponse {
  readonly httpStatus: number;
  readonly body: Buffer;
}

export interface AceTransport {
  postJson(request: AceJsonRequest): Promise<AceJsonResponse>;
  getBinary(request: AceBinaryRequest): Promise<AceBinaryResponse>;
}

export interface AceHttpTransportConfig {
  /** Engine origin, e.g. `http://ace-step.internal:8000`. No trailing slash needed. */
  readonly baseUrl: string;
  /**
   * Sent as `Authorization: Bearer …`.
   *
   * The engine also accepts the token in the request body as `ai_token`
   * (`verify_token_from_request`); the header form is used so a credential never
   * appears in a payload that gets logged or asserted on.
   */
  readonly apiToken?: string;
  /** Injected so the production adapter is testable without a global stub. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Production transport over `fetch`.
 *
 * No timeout of its own: Requirement 20.14's 300-second cap is applied by
 * `callRemoteEngine` around the whole adapter call, and duplicating a budget here
 * would create a second, quieter deadline.
 */
export function createAceHttpTransport(config: AceHttpTransportConfig): AceTransport {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const origin = config.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiToken !== undefined) headers.authorization = `Bearer ${config.apiToken}`;

  return {
    async postJson(request) {
      const response = await fetchImpl(`${origin}${request.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
      });
      return {
        httpStatus: response.status,
        envelope: (await response.json()) as AceEnvelope,
      };
    },

    async getBinary(request) {
      const query = new URLSearchParams(request.query).toString();
      const suffix = query === '' ? '' : `?${query}`;
      const response = await fetchImpl(`${origin}${request.path}${suffix}`, {
        method: 'GET',
        ...(config.apiToken === undefined
          ? {}
          : { headers: { authorization: `Bearer ${config.apiToken}` } }),
      });
      return {
        httpStatus: response.status,
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}
