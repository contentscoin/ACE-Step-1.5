import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { createStudioBackend } from './lib/api/create';
import './styles/index.css';

/**
 * React Query for server state, Zustand for client state (design §8.1). The client is created
 * once here rather than per render, which is the whole of what "server state / client state
 * separation" needs at this stage — 7.3 adds the queries.
 */
const queryClient = new QueryClient();

/**
 * The one line the roadmap's track C1 said this would be.
 *
 * `VITE_MUSICSTUDIO_API_URL` names a gateway and its absence is the demo — see `create.ts`.
 * Built once, outside the render, because the session it carries is the browser's and a second
 * one would be a second idea of who is signed in.
 */
const backend = createStudioBackend();

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App api={backend.api} session={backend.session} gatewayUrl={backend.gatewayUrl} />
    </QueryClientProvider>
  </StrictMode>,
);
