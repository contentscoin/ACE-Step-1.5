import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { boundaryRules } from '../../eslint.boundary.mjs';

/**
 * Regression guard for the coupling invariant (design §1.4.4, §14 risk #9).
 *
 * The lint rules themselves are the enforcement mechanism, so they get their
 * own test: if the rule configuration is ever weakened, this fails instead of
 * the violation slipping through silently.
 */
const linter = new Linter();

function lint(code: string): Linter.LintMessage[] {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: boundaryRules,
  });
}

describe('acestep import boundary lint rules', () => {
  const violations = [
    "import { pipeline } from 'acestep/pipeline_ace_step';",
    "import x from '../../acestep/models/ace_step_transformer';",
    "export { default } from './acestep/index.js';",
    "const mod = await import('../../acestep/apps/api_server');",
    "const mod = require('acestep');",
  ];

  it.each(violations)('reports an error for %s', (code) => {
    const messages = lint(code);

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.message).toContain('musicstudio/ must not import acestep/');
  });

  const allowed = [
    "import { request } from 'undici';",
    "import { EngineDescriptor } from '../../adapters/registry/descriptor.js';",
    "const engineBaseUrl = 'http://acestep-engine.internal:8000';",
  ];

  it.each(allowed)('permits %s', (code) => {
    expect(lint(code)).toHaveLength(0);
  });
});
