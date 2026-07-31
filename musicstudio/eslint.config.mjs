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
);
