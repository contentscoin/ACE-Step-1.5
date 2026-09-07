/**
 * The gateway session: the tokens, where they are kept, and how they are refreshed.
 *
 * Separate from `http-api.ts` because the two answer different questions. The client maps
 * product calls onto routes; this owns one fact — whether there is a live credential — and every
 * screen that has to know reads it here.
 *
 * ### `localStorage`, and what that costs
 *
 * The access token lives 24 hours and the refresh token 30 days (Requirement 1.3), so keeping
 * them only in memory would sign the user out on every reload — which is not a security posture,
 * it is an annoyance that trains people to re-enter passwords. `localStorage` is readable by any
 * script on the origin, so this is worth stating plainly rather than leaving implied: it is the
 * standard trade for a token-based SPA, and the thing that would replace it is a `HttpOnly`
 * cookie, which the gateway does not issue.
 *
 * ### One refresh at a time
 *
 * Several requests can meet a 401 at once — a screen loads a listing, a waveform and an asset
 * together. Each retrying its own refresh would spend the refresh token several times over, and
 * `Account_Service` rotates it, so all but one of those would fail and sign the user out. So the
 * first 401 starts a refresh and the rest await the same promise.
 */

const STORAGE_KEY = 'musicstudio.session';

export interface SessionTokens {
  readonly accountId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface SessionState {
  readonly tokens: SessionTokens | null;
}

export type SessionListener = (state: SessionState) => void;

/** `localStorage` throws in a sandboxed frame and is absent in some test DOMs. */
function readStored(): SessionTokens | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<SessionTokens>;
    if (
      typeof candidate.accountId !== 'string' ||
      typeof candidate.email !== 'string' ||
      typeof candidate.accessToken !== 'string' ||
      typeof candidate.refreshToken !== 'string'
    ) {
      return null;
    }
    return {
      accountId: candidate.accountId,
      email: candidate.email,
      accessToken: candidate.accessToken,
      refreshToken: candidate.refreshToken,
    };
  } catch {
    return null;
  }
}

function writeStored(tokens: SessionTokens | null): void {
  try {
    if (tokens === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    // A session that cannot be persisted is still a session for this tab.
  }
}

export interface Session {
  current(): SessionTokens | null;
  set(tokens: SessionTokens | null): void;
  subscribe(listener: SessionListener): () => void;
  /**
   * Exchanges the refresh token for a new pair, at most once at a time.
   *
   * Returns the new access token, or `null` when there is nothing to refresh with or the
   * gateway refused — in which case the session has been cleared and the user must sign in.
   */
  refresh(): Promise<string | null>;
}

export interface SessionOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Starts empty instead of reading storage. Tests use this; nothing else should. */
  readonly initial?: SessionTokens | null;
}

export function createSession(options: SessionOptions): Session {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let tokens = options.initial === undefined ? readStored() : options.initial;
  const listeners = new Set<SessionListener>();
  let refreshing: Promise<string | null> | null = null;

  function publish(): void {
    const state: SessionState = { tokens };
    for (const listener of listeners) listener(state);
  }

  function setTokens(next: SessionTokens | null): void {
    tokens = next;
    writeStored(next);
    publish();
  }

  return {
    current: () => tokens,
    set: setTokens,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async refresh() {
      const refreshToken = tokens?.refreshToken;
      if (refreshToken === undefined) return null;
      // Everyone who arrives while one is in flight waits for it; see the header.
      refreshing ??= (async () => {
        try {
          const response = await fetchImpl(`${options.baseUrl}/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          });
          if (!response.ok) {
            setTokens(null);
            return null;
          }
          const body = (await response.json()) as SessionTokens;
          setTokens({
            accountId: body.accountId,
            email: body.email,
            accessToken: body.accessToken,
            refreshToken: body.refreshToken,
          });
          return body.accessToken;
        } catch {
          // A network failure is not an expired session: keep the tokens so the next attempt
          // can use them, and let the caller surface the transport error.
          return null;
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    },
  };
}
