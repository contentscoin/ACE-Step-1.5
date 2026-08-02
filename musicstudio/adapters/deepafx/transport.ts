/**
 * The HTTP seam to a DeepAFx deployment (design §1.4.4, §11.3).
 *
 * `DeepAfxAdapter` never calls `fetch`; it calls this port, for the two reasons
 * `adapters/woosh/transport.ts` gives — the wire payload becomes an assertable value, and no
 * test needs a running service.
 *
 * The second reason is decisive here. **DeepAFx is not reachable from this environment** and
 * its licence is non-commercial, so every statement this repository makes about the wire form
 * is a statement about what *would* be sent, checked against a deterministic in-memory fake
 * (`test/support/mastering-harness.ts`). The envelope shape below is therefore **unverified
 * against a real deployment** and is the one thing in the mastering path that must be
 * confirmed before the adapter is pointed at a live service: a §14 risk to settle with
 * whoever owns the deployment.
 *
 * What *is* settled, and what the rest of the system depends on, is that the adapter
 * implements `SuggestionModelPort` and nothing else — so if the envelope turns out to differ,
 * the change is confined to this folder. Requirements 30.20 and 30.21 are satisfied by the
 * adapter regardless of what the envelope looks like, because they are about the *absence*
 * of a response.
 *
 * No timeout of its own: Requirement 30.20's 120-second budget is applied by the adapter
 * through the injectable `TimeoutRunner`, and a second, quieter deadline here would make the
 * effective budget unknowable. That is the same rule `adapters/woosh/transport.ts` follows
 * for Requirement 20.14.
 */

/** The response body a DeepAFx suggestion route is assumed to return. */
export interface DeepAfxEnvelope {
  /** The suggested chain, in `Chain_Parser` form (Requirement 29.25). */
  readonly chain?: unknown;
  /** Model build identifier, recorded on the suggestion's provenance. */
  readonly model?: unknown;
  readonly error?: unknown;
}

export interface DeepAfxSuggestRequest {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface DeepAfxSuggestResponse {
  readonly httpStatus: number;
  readonly envelope: DeepAfxEnvelope;
}

export interface DeepAfxTransport {
  postJson(request: DeepAfxSuggestRequest): Promise<DeepAfxSuggestResponse>;
}

export interface DeepAfxHttpTransportConfig {
  /** Service origin, e.g. `http://deepafx.internal:8300`. No trailing slash needed. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer …`, so a credential never appears in a payload. */
  readonly apiToken?: string;
  /** Injected so the production transport is testable without a global stub. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export function createDeepAfxHttpTransport(
  config: DeepAfxHttpTransportConfig,
): DeepAfxTransport {
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
        envelope: (await response.json()) as DeepAfxEnvelope,
      };
    },
  };
}
