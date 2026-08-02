/**
 * The HTTP seam to a Woosh deployment (design §1.4.4).
 *
 * `WooshEngineAdapter` never calls `fetch`; it calls this port, for the two reasons
 * `adapters/ace/transport.ts` gives — the wire payload becomes an assertable value, and no
 * test needs a running engine.
 *
 * The second reason is not a convenience here. **No Woosh service is reachable from this
 * environment**, so every statement this repository makes about the wire form is a
 * statement about what would be sent, checked against a scripted transport. The envelope
 * shape below is therefore **unverified against a real deployment** and is the one thing in
 * the SFX path that must be confirmed before the adapter is pointed at a live engine:
 * §14 risk to settle with whoever owns the Woosh deployment.
 *
 * What *is* settled, and what the rest of the system depends on, is that the adapter
 * implements `EngineAdapter` and nothing else — so if the envelope turns out to differ, the
 * change is confined to this folder.
 */

/** The response body a Woosh JSON route is assumed to return. */
export interface WooshEnvelope {
  readonly data?: unknown;
  /** Application-level status, independent of the HTTP status. */
  readonly code?: unknown;
  readonly error?: unknown;
}

export interface WooshJsonRequest {
  /** Engine path, e.g. `/v1/sfx/submit`. */
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface WooshJsonResponse {
  readonly httpStatus: number;
  readonly envelope: WooshEnvelope;
}

export interface WooshBinaryRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface WooshBinaryResponse {
  readonly httpStatus: number;
  readonly body: Buffer;
}

export interface WooshTransport {
  postJson(request: WooshJsonRequest): Promise<WooshJsonResponse>;
  getBinary(request: WooshBinaryRequest): Promise<WooshBinaryResponse>;
}

export interface WooshHttpTransportConfig {
  /** Engine origin, e.g. `http://woosh.internal:8100`. No trailing slash needed. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer …`, so a credential never appears in a payload. */
  readonly apiToken?: string;
  /** Injected so the production transport is testable without a global stub. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Production transport over `fetch`.
 *
 * No timeout of its own: Requirement 20.14's 300-second cap is applied by
 * `callRemoteEngine` around the whole adapter call, and a second, quieter deadline here
 * would make the effective budget unknowable.
 */
export function createWooshHttpTransport(config: WooshHttpTransportConfig): WooshTransport {
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
        envelope: (await response.json()) as WooshEnvelope,
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
