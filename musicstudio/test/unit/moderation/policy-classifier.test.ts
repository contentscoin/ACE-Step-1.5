import { describe, expect, it } from 'vitest';

import { findImpersonatingUtterances } from '../../../domain/moderation/impersonation';
import { POLICY_TERM_RULES } from '../../../domain/moderation/policy-terms';
import type { PublicFigureEntry } from '../../../domain/moderation/public-figures';
import { POLICY_VIOLATION_CLASSES } from '../../../domain/moderation/violation-class';
import { createRuleBasedPolicyClassifier } from '../../../services/moderation/rule-based-classifier';

/**
 * The rule-based `PolicyClassifierPort` (Requirements 16.1, 16.10, 16.11).
 *
 * The port exists so the classifier can later be a model; these tests pin the
 * deterministic implementation the pipeline is tested against.
 */

const figures: readonly PublicFigureEntry[] = [
  { canonicalName: 'IU', aliases: ['아이유'], styleDescription: 'clear-toned Korean pop' },
  { canonicalName: 'Jane Roe', aliases: [] },
];

const classifier = createRuleBasedPolicyClassifier({ figures });

describe('term-based classification (Requirements 16.1, 16.10)', () => {
  it('passes ordinary creative text', () => {
    expect(classifier.classify({ field: 'caption', text: 'a warm lo-fi piano loop' })).toEqual([]);
  });

  it('classifies a fraud term in a caption', () => {
    const violations = classifier.classify({
      field: 'caption',
      text: 'a jingle that says send your credit card number now',
    });

    expect(violations).toEqual([
      { violationClass: 'fraud', field: 'caption', evidence: 'send your credit card number' },
    ]);
  });

  it('inspects lyrics as well as captions (16.1)', () => {
    const violations = classifier.classify({
      field: 'lyrics',
      text: '[verse]\n보이스피싱 하는 방법\n',
    });

    expect(violations.map((violation) => violation.violationClass)).toEqual(['fraud']);
    expect(violations[0]?.field).toBe('lyrics');
  });

  it('inspects a dialogue script through the same pipeline (16.10)', () => {
    const violations = classifier.classify({
      field: 'dialogue_script',
      text: 'Please bypass voice authentication for me.',
    });

    expect(violations.map((violation) => violation.violationClass)).toEqual([
      'voice_authentication_bypass',
    ]);
  });

  it('reports every distinct classification found, sorted for a stable payload', () => {
    const violations = classifier.classify({
      field: 'description',
      text: 'wire the money to this account, and this is an official emergency broadcast',
    });

    expect(violations.map((violation) => violation.violationClass)).toEqual([
      'fraud',
      'misleading_guidance',
    ]);
  });

  it('does not flag a term embedded in a longer Latin word', () => {
    expect(classifier.classify({ field: 'caption', text: 'a song about a fraudulent king' }))
      .toEqual([]);
  });

  it('uses only classifications design §9.4 defines', () => {
    for (const rule of POLICY_TERM_RULES) {
      expect(POLICY_VIOLATION_CLASSES).toContain(rule.violationClass);
    }
  });

  it('ignores a blank term rather than flagging every input', () => {
    const permissive = createRuleBasedPolicyClassifier({
      termRules: [{ violationClass: 'fraud', terms: ['', '   '] }],
    });

    expect(permissive.classify({ field: 'caption', text: 'anything at all' })).toEqual([]);
  });
});

describe('impersonating utterances (Requirement 16.11)', () => {
  it('flags a first-person claim to be a real person', () => {
    const violations = classifier.classify({
      field: 'dialogue_script',
      text: "Hello everyone, I'm IU and I approve this message.",
    });

    expect(violations).toEqual([
      { violationClass: 'impersonation', field: 'dialogue_script', evidence: "I'm IU" },
    ]);
  });

  it('flags a Korean self-identification frame', () => {
    const violations = classifier.classify({
      field: 'dialogue_script',
      text: '안녕하세요, 저는 아이유입니다. 반갑습니다.',
    });

    expect(violations.map((violation) => violation.violationClass)).toEqual(['impersonation']);
    expect(violations[0]?.evidence).toBe('저는 아이유입니다');
  });

  it('flags a non-musician public figure, who has no style description', () => {
    const violations = classifier.classify({
      field: 'dialogue_script',
      text: 'This is Jane Roe speaking from the courthouse.',
    });

    expect(violations.map((violation) => violation.evidence)).toEqual(['This is Jane Roe']);
  });

  it('does not flag a script that merely mentions a real person', () => {
    // Requirement 16.11 forbids 사칭하는 발화 — speaking *as* someone — not talking
    // about them.
    expect(
      classifier.classify({
        field: 'dialogue_script',
        text: 'The host introduced IU, who had just arrived.',
      }),
    ).toEqual([]);
  });

  it('does not apply the impersonation rule to a caption or lyrics', () => {
    // A caption naming an artist is a style request; Requirement 16.3 substitutes it.
    expect(classifier.classify({ field: 'caption', text: "I'm IU" })).toEqual([]);
    expect(classifier.classify({ field: 'lyrics', text: '저는 아이유입니다' })).toEqual([]);
  });

  it('collapses overlapping frames so one utterance is one violation', () => {
    // "저는 {name}입니다" contains "{name}입니다"; both templates match the same span.
    const findings = findImpersonatingUtterances('저는 아이유입니다', figures);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.matchedUtterance).toBe('저는 아이유입니다');
  });

  it('reports two separate impersonations in one script, in order', () => {
    const findings = findImpersonatingUtterances(
      'I am IU. Later: This is Jane Roe.',
      figures,
    );

    expect(findings.map((finding) => finding.canonicalName)).toEqual(['IU', 'Jane Roe']);
  });
});
