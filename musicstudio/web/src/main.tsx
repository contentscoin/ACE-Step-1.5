import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import './styles/index.css';

/**
 * React Query for server state, Zustand for client state (design §8.1). The client is created
 * once here rather than per render, which is the whole of what "server state / client state
 * separation" needs at this stage — 7.3 adds the queries.
 */
const queryClient = new QueryClient();

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
