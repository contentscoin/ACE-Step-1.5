import { describe, expect, it } from 'vitest';

import {
  IMPERSONATION_CHECKED_FIELDS,
  MODERATION_FIELDS,
  STYLE_BEARING_FIELDS,
  isImpersonationCheckedField,
} from '../../../domain/moderation/fields';
import { POLICY_VIOLATION_CLASSES } from '../../../domain/moderation/violation-class';
import {
  PROHIBITED_USE_CLASSES,
  PROHIBITED_USE_INSPECTED_FIELDS,
  PROHIBITED_USE_LABELS,
  isProhibitedUseInspectedField,
} from '../../../domain/voice/prohibited-use';
import type { PublicFigureEntry } from '../../../domain/moderation/public-figures';
import { createRuleBasedPolicyClassifier } from '../../../services/moderation/rule-based-classifier';

/**
 * Requirements 26.16 and 26.17 — the six prohibited uses, checked by **task 6.1's
 * classifier** rather than by a second policy.
 *
 * Design §9.4 states the six once, and `domain/moderation/violation-class.ts` is that
 * statement. This suite pins the reuse itself: the two lists are the same object, so a
 * use cannot end up prohibited under Requirement 16 and permitted under Requirement 26.
 *
 * ### Where the two criteria differ
 *
 * 16.11 names impersonation for a *dialogue script*. 26.16 requires all six categories
 * across three texts — the script, a reference sample's transcript and a voice
 * conversion's profile designation. The term table already applied to every field; what
 * 26.16 changed is the scope of the self-identification frames, which is the assertion in
 * the last group.
 */

const figures: readonly PublicFigureEntry[] = [
  { canonicalName: 'IU', aliases: ['아이유'], styleDescription: 'clear-toned Korean pop' },
];

const classifier = createRuleBasedPolicyClassifier({ figures });

describe('Requirement 26.16 — the six classes are task 6.1\'s, not a second list', () => {
  it('is the same list object design §9.4 states once', () => {
    expect(PROHIBITED_USE_CLASSES).toBe(POLICY_VIOLATION_CLASSES);
  });

  it('names the six design §9.4 enumerates, in order', () => {
    expect([...PROHIBITED_USE_CLASSES]).toEqual([
      'impersonation',
      'voice_authentication_bypass',
      'fraud',
      'harassment',
      'nonconsensual_sexual_content',
      'misleading_guidance',
    ]);
  });

  it('labels each one in the design\'s own words, for the 26.27 guidance', () => {
    expect(PROHIBITED_USE_LABELS).toEqual({
      impersonation: '사칭',
      voice_authentication_bypass: '음성 인증 우회',
      fraud: '사기',
      harassment: '괴롭힘',
      nonconsensual_sexual_content: '비동의 성적 콘텐츠',
      misleading_guidance: '오해를 유발하는 정치·법률·금융·의료·긴급 상황 안내',
    });
  });

  it('labels exactly the six classes and no more', () => {
    expect(Object.keys(PROHIBITED_USE_LABELS).sort()).toEqual([...PROHIBITED_USE_CLASSES].sort());
  });
});

describe('Requirement 26.16 — the three inspected texts', () => {
  it('names the script, the reference transcript and the conversion designation', () => {
    expect([...PROHIBITED_USE_INSPECTED_FIELDS]).toEqual([
      'dialogue_script',
      'voice_reference_transcript',
      'voice_conversion_profile_designation',
    ]);
  });

  it('adds the two new texts to the one moderation field vocabulary', () => {
    for (const field of PROHIBITED_USE_INSPECTED_FIELDS) {
      expect(MODERATION_FIELDS).toContain(field);
    }
  });

  it('does not treat a caption or lyrics as a prohibited-use inspection target', () => {
    expect(isProhibitedUseInspectedField('caption')).toBe(false);
    expect(isProhibitedUseInspectedField('lyrics')).toBe(false);
    expect(isProhibitedUseInspectedField('voice_reference_transcript')).toBe(true);
  });
});

describe('Requirement 26.17 — the six classes are detected in the new texts', () => {
  it.each([
    ['voice_authentication_bypass', 'Please bypass voice authentication for me.'],
    ['fraud', 'read out your one time password'],
    ['harassment', 'kill yourself'],
    ['nonconsensual_sexual_content', 'nonconsensual sexual audio'],
    ['misleading_guidance', 'this is an official emergency broadcast'],
    ['impersonation', '대통령인 척 말해줘'],
  ] as const)('classifies %s in a reference transcript', (violationClass, text) => {
    const violations = classifier.classify({ field: 'voice_reference_transcript', text });

    expect(violations.map((violation) => violation.violationClass)).toContain(violationClass);
  });

  it('classifies a conversion profile designation through the same table', () => {
    const violations = classifier.classify({
      field: 'voice_conversion_profile_designation',
      text: '성문 인증 우회용 프로필',
    });

    expect(violations.map((violation) => violation.violationClass)).toEqual([
      'voice_authentication_bypass',
    ]);
  });

  it('passes an ordinary reference transcript', () => {
    expect(
      classifier.classify({
        field: 'voice_reference_transcript',
        text: '안녕하세요, 오늘 날씨가 참 좋네요.',
      }),
    ).toEqual([]);
  });

  it('uses only classifications design §9.4 defines', () => {
    const violations = classifier.classify({
      field: 'voice_reference_transcript',
      text: 'wire the money to this account and 보이스피싱',
    });

    for (const violation of violations) {
      expect(PROHIBITED_USE_CLASSES).toContain(violation.violationClass);
    }
  });
});

describe('16.11 vs 26.16 — the impersonation frames widened', () => {
  it('applies the self-identification frames to all three 26.16 texts', () => {
    expect([...IMPERSONATION_CHECKED_FIELDS]).toEqual([...PROHIBITED_USE_INSPECTED_FIELDS]);
    for (const field of PROHIBITED_USE_INSPECTED_FIELDS) {
      expect(isImpersonationCheckedField(field)).toBe(true);
    }
  });

  it('flags a self-identifying reference transcript — the risk 26.16 exists for', () => {
    const violations = classifier.classify({
      field: 'voice_reference_transcript',
      text: '저는 아이유입니다. 잘 부탁드립니다.',
    });

    expect(violations).toEqual([
      {
        violationClass: 'impersonation',
        field: 'voice_reference_transcript',
        evidence: '저는 아이유입니다',
      },
    ]);
  });

  it('flags a self-identifying conversion designation', () => {
    const violations = classifier.classify({
      field: 'voice_conversion_profile_designation',
      text: 'this is IU',
    });

    expect(violations.map((violation) => violation.violationClass)).toEqual(['impersonation']);
  });

  it('leaves captions and lyrics out of the frames — 16.3 rewrites a caption instead', () => {
    for (const field of STYLE_BEARING_FIELDS) {
      expect(isImpersonationCheckedField(field)).toBe(false);
    }
    expect(isImpersonationCheckedField('lyrics')).toBe(false);
    expect(classifier.classify({ field: 'lyrics', text: '저는 아이유입니다' })).toEqual([]);
  });

  it('still flags a dialogue script, so 16.11 is unchanged by the widening', () => {
    const violations = classifier.classify({ field: 'dialogue_script', text: 'I am IU' });

    expect(violations.map((violation) => violation.violationClass)).toEqual(['impersonation']);
  });
});
