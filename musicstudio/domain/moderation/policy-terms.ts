/**
 * Term rule table for content policy inspection — **data, not logic**.
 *
 * Requirements 16.1 and 16.10 require that submitted text be inspected against the
 * content policy; 16.2 and 16.11 require a classification when it fails. This table
 * maps evidence to one of the six classifications in `violation-class.ts`.
 *
 * It is a seed list, not a policy. The rule that consumes it
 * (`services/moderation/rule-based-classifier.ts`) takes the table as an argument,
 * so a deployment can supply a maintained list — and so the classifier can be
 * swapped for a model without any rule moving (see `PolicyClassifierPort`).
 *
 * Terms are matched by `text-match.ts`: case-insensitive, whitespace-flexible, and
 * refusing to match inside a longer Latin word.
 */

import type { PolicyViolationClass } from './violation-class';

export interface PolicyTermRule {
  readonly violationClass: PolicyViolationClass;
  readonly terms: readonly string[];
}

export const POLICY_TERM_RULES: readonly PolicyTermRule[] = [
  {
    violationClass: 'impersonation',
    terms: ['pretend to be the president', 'speak as the prime minister', '대통령인 척'],
  },
  {
    violationClass: 'voice_authentication_bypass',
    terms: [
      'bypass voice authentication',
      'defeat the voiceprint check',
      'unlock the bank account with my voice',
      '성문 인증 우회',
    ],
  },
  {
    violationClass: 'fraud',
    terms: [
      'send your credit card number',
      'wire the money to this account',
      'read out your one time password',
      '보이스피싱',
    ],
  },
  {
    violationClass: 'harassment',
    terms: ['i will find you and hurt you', 'kill yourself', '죽여버릴 거야'],
  },
  {
    violationClass: 'nonconsensual_sexual_content',
    terms: ['nonconsensual sexual', 'without her consent sexually', '비동의 성적'],
  },
  {
    violationClass: 'misleading_guidance',
    terms: [
      'this is an official emergency broadcast',
      'the election has been cancelled',
      'stop taking your prescribed medication',
      '긴급 재난 방송입니다',
    ],
  },
];
