import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Property suites (design §10) run at least 100 cases each; give them room.
    testTimeout: 30_000,
  },
});
