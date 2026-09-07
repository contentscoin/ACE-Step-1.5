/**
 * The gateway session as context, and a hook that re-renders when it changes.
 *
 * A separate context from `StudioApiContext` because the two have different lifetimes and
 * different audiences: every screen uses the api, and only the sign-in panel and the shell care
 * whether there is a credential. Folding the session into the api would also mean the demo
 * backend had to answer questions about accounts it does not have.
 *
 * `null` is the honest value for a demo build: there is no session, as against an empty one.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import type { Session, SessionTokens } from './session';

const GatewaySessionContext = createContext<Session | null>(null);

export interface GatewaySessionProviderProps {
  readonly session: Session | null;
  readonly children: ReactNode;
}

export function GatewaySessionProvider({
  session,
  children,
}: GatewaySessionProviderProps): ReactNode {
  return (
    <GatewaySessionContext.Provider value={session}>{children}</GatewaySessionContext.Provider>
  );
}

/** The session, or `null` on a demo build. */
export function useGatewaySession(): Session | null {
  return useContext(GatewaySessionContext);
}

/**
 * Who is signed in, kept current.
 *
 * Subscribes rather than reading once: a token refresh, a sign-out, or a sign-in from the panel
 * all change this, and a component that read the value at mount would keep showing the old one.
 */
export function useSessionTokens(): SessionTokens | null {
  const session = useGatewaySession();
  const [tokens, setTokens] = useState<SessionTokens | null>(() => session?.current() ?? null);

  useEffect(() => {
    if (session === null) {
      setTokens(null);
      return;
    }
    setTokens(session.current());
    return session.subscribe((state) => {
      setTokens(state.tokens);
    });
  }, [session]);

  return tokens;
}
