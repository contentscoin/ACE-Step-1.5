/**
 * Deterministic rule-based `PolicyClassifierPort` (Requirements 16.1, 16.10, 16.11).
 *
 * Two sources of evidence, both table-driven:
 *
 * - the term table (`domain/moderation/policy-terms.ts`), applied to every field;
 * - impersonating utterances (`domain/moderation/impersonation.ts`), applied to the
 *   fields in `IMPERSONATION_CHECKED_FIELDS` — Requirement 16.11's dialogue script
 *   plus the two texts Requirement 26.16 adds.
 *
 * Results are sorted so two runs over the same input produce byte-identical
 * payloads. That matters beyond tidiness: the violation list ends up in an
 * append-only audit entry, and an unordered list would make two identical blocks
 * look like two different events.
 */

import { isImpersonationCheckedField } from '../../domain/moderation/fields';
import type { PublicFigureEntry } from '../../domain/moderation/public-figures';
import { findImpersonatingUtterances } from '../../domain/moderation/impersonation';
import { POLICY_TERM_RULES, type PolicyTermRule } from '../../domain/moderation/policy-terms';
import { findPhraseMatches } from '../../domain/moderation/text-match';

import type {
  PolicyClassificationInput,
  PolicyClassifierPort,
  PolicyViolation,
} from './policy-classifier';

export interface RuleBasedClassifierOptions {
  readonly termRules?: readonly PolicyTermRule[];
  readonly figures?: readonly PublicFigureEntry[];
}

export function createRuleBasedPolicyClassifier(
  options: RuleBasedClassifierOptions = {},
): PolicyClassifierPort {
  const termRules = options.termRules ?? POLICY_TERM_RULES;

  return {
    classify(input: PolicyClassificationInput): readonly PolicyViolation[] {
      const violations = [...termViolations(input, termRules)];

      // Requirement 16.11 (dialogue script) and Requirement 26.16 (reference
      // transcript, conversion profile designation). See
      // `IMPERSONATION_CHECKED_FIELDS` for why captions and lyrics are excluded.
      if (isImpersonationCheckedField(input.field)) {
        for (const finding of findImpersonatingUtterances(input.text, options.figures)) {
          violations.push({
            violationClass: 'impersonation',
            field: input.field,
            evidence: finding.matchedUtterance,
          });
        }
      }

      return dedupe(violations);
    },
  };
}

function termViolations(
  input: PolicyClassificationInput,
  termRules: readonly PolicyTermRule[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  for (const rule of termRules) {
    for (const term of rule.terms) {
      for (const match of findPhraseMatches(input.text, term)) {
        violations.push({
          violationClass: rule.violationClass,
          field: input.field,
          evidence: match.matchedText,
        });
      }
    }
  }

  return violations;
}

/** One entry per (class, evidence) pair, ordered by class then evidence. */
function dedupe(violations: readonly PolicyViolation[]): readonly PolicyViolation[] {
  const unique = new Map<string, PolicyViolation>();
  for (const violation of violations) {
    unique.set(`${violation.violationClass}\u0000${violation.evidence.toLowerCase()}`, violation);
  }

  return [...unique.values()].sort(
    (left, right) =>
      left.violationClass.localeCompare(right.violationClass, 'en') ||
      left.evidence.localeCompare(right.evidence, 'en'),
  );
}
