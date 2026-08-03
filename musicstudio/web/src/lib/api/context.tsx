/**
 * The `StudioApi` a screen uses, as context.
 *
 * A provider rather than a module-level singleton, so a test renders a screen against its own
 * backend without resetting global state between cases — and so pointing the app at the HTTP
 * gateway (task 9.1) is one line in `main.tsx`.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';

import { createDemoApi } from './demo-api';
import type { StudioApi } from './port';

const StudioApiContext = createContext<StudioApi | null>(null);

export interface StudioApiProviderProps {
  readonly api?: StudioApi;
  readonly children: ReactNode;
}

export function StudioApiProvider({ api, children }: StudioApiProviderProps): ReactNode {
  // The demo backend holds the session's state — published assets, renames, timeline history — so
  // it is created once and not per render. `useState`'s initialiser rather than `useMemo`, which
  // React is permitted to discard and recompute; discarding this one would silently roll the
  // session back to the seed.
  const [fallback] = useState(() => createDemoApi());

  return (
    <StudioApiContext.Provider value={api ?? fallback}>{children}</StudioApiContext.Provider>
  );
}

export function useStudioApi(): StudioApi {
  const api = useContext(StudioApiContext);
  if (api === null) throw new Error('a screen was rendered outside StudioApiProvider');
  return api;
}
