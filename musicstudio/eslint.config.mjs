import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import { boundaryRules } from './eslint.boundary.mjs';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'build/**', 'coverage/**', 'dsp/**', 'web/dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}'],
    rules: boundaryRules,
  },
  // Build scripts run under Node with no bundler, so they use Node's globals directly.
  // `no-undef` cannot know that from the file alone — TypeScript sources get it from
  // `@types/node`, and these are plain ESM.
  {
    files: ['**/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },

  // `verify-a11y-browser.mjs` is a Node script whose `page.evaluate` callbacks are serialised and
  // run **inside Chromium**. Those callbacks legitimately use browser globals that do not exist in
  // the Node process running the file, and `no-undef` cannot tell the two contexts apart.
  {
    files: ['**/scripts/verify-a11y-browser.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        globalThis: 'readonly',
      },
    },
  },
);
