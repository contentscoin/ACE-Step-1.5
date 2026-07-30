/**
 * Coupling invariant enforcement (design §1.4.4, §14 risk #9).
 *
 * No module under `musicstudio/` may import anything from the host engine
 * package `acestep/`. The single sanctioned coupling point is the HTTP
 * interface called by `ACE_Engine_Adapter` (§3.1, §3.6).
 *
 * There are no exemptions: a violation must fail lint, and therefore CI.
 */

/** Import specifiers that resolve into the engine package, in any spelling. */
export const FORBIDDEN_IMPORT_PATTERNS = [
  'acestep',
  'acestep/**',
  '**/acestep',
  '**/acestep/**',
];

export const BOUNDARY_MESSAGE =
  'Coupling invariant violation (design §1.4.4): musicstudio/ must not import acestep/. ' +
  'Reach the engine only through the ACE_Engine_Adapter HTTP interface (§3.1).';

/** Selector fragment matching an `acestep` module string in any literal position. */
const ACESTEP_LITERAL = '[value=/(^|\\/)acestep(\\/|$)/]';

/** @type {import('eslint').Linter.RulesRecord} */
export const boundaryRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: FORBIDDEN_IMPORT_PATTERNS,
          message: BOUNDARY_MESSAGE,
        },
      ],
    },
  ],
  // `no-restricted-imports` does not cover dynamic import() or require(),
  // so the same boundary is asserted syntactically for both forms.
  'no-restricted-syntax': [
    'error',
    {
      selector: `ImportExpression > Literal${ACESTEP_LITERAL}`,
      message: BOUNDARY_MESSAGE,
    },
    {
      selector: `CallExpression[callee.name='require'] > Literal${ACESTEP_LITERAL}`,
      message: BOUNDARY_MESSAGE,
    },
  ],
};
