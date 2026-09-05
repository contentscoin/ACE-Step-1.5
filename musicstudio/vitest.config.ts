import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // One event-loop turn between tests, so a CPU-bound file cannot starve the worker's
    // reporting RPC past birpc's 60 s limit. The file explains the failure it prevents.
    setupFiles: ['test/support/yield-between-tests.ts'],
    // Property suites (design §10) run at least 100 cases each; give them room.
    testTimeout: 30_000,
  },
});
