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
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
);
