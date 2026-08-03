/**
 * Vite configuration (design §8.1, Requirements 31.15, 31.16).
 *
 * ### The build reaches no network
 *
 * Requirement 31.15 requires a build to succeed with **no access to the external registry** and
 * still ship the four component categories of 31.1. That is satisfied structurally rather than by
 * a retry policy: the Amicro components are *vendored* under `src/components/amicro/`, so nothing
 * in this config, in `postinstall`, or in a plugin fetches anything. `amicro/registry.json` records
 * which registry version they came from — see `src/components/amicro/README.md` for the provenance
 * and the one thing that is unverified about it.
 *
 * ### The static check runs before the bundler
 *
 * Requirement 31.5 says a violation produces **no build artefact**. `npm run build` therefore runs
 * `check:motion` first and `vite build` only if it passed — a Vite plugin doing the same work would
 * run after the output directory had already been written for a watch build.
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The UI applies the *same* rule functions the services do — see `src/lib/api/README.md`.
      // A screen that re-derived "which assets are in this listing" or "which byte window is this"
      // would be a second answer to a question the domain already answers.
      '@domain': fileURLToPath(new URL('../domain', import.meta.url)),
    },
  },
  build: {
    // A named directory rather than the default, because `eslint.config.mjs` and the repository's
    // ignore rules already name `web/dist`.
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'happy-dom',
  },
});
