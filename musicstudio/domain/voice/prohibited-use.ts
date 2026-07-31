/**
 * Requirement 26.16 — the six prohibited uses, and the three texts they are checked
 * against.
 *
 * **The six classifications are task 6.1's, not a second list.** Design §9.4 states
 * them once and `domain/moderation/violation-class.ts` is that statement;
 * Requirement 16 and Requirement 26 refer to the same table. This module re-exports it
 * rather than restating it, so there is no way for the two requirements to end up with
 * divergent spellings of the same six categories — which is the failure mode that
 * would let a use be prohibited under one criterion and permitted under the other.
 *
 * What 26.16 adds is **scope**: two inspection targets beyond 16.10's dialogue script.
 *
 * | 26.16 target | field |
 * |---|---|
 * | 대사 스크립트 텍스트 | `dialogue_script` (already 16.10's) |
 * | 참조 음성 샘플의 참조 텍스트 | `voice_reference_transcript` |
 * | 음성 변환 요청의 프로필 지정 정보 | `voice_conversion_profile_designation` |
 *
 * ### Where 16.11 and 26.16 differ
 *
 * 16.11 is narrower than 26.16 in one respect and identical in the rest. It names
 * *impersonation* specifically, and only for a dialogue script. 26.16 requires all six
 * categories across all three texts. The rule-based classifier therefore applies its
 * self-identification frames to the fields in `IMPERSONATION_CHECKED_FIELDS` — the
 * union of 16.11's script and 26.16's two new texts — and its term table to every
 * field, as before. A reference transcript reading "저는 대통령입니다" is the exact
 * risk 26.16 exists for, so leaving the frames scoped to scripts would have satisfied
 * the letter of 16.11 while missing 26.16.
 *
 * Captions and lyrics remain excluded from the frames: Requirement 16.3 rewrites an
 * artist name in a caption rather than blocking it, and a lyric is content rather than
 * a claim of identity.
 */

import type { ModerationField } from '../moderation/fields';
import {
  POLICY_VIOLATION_CLASSES,
  isPolicyViolationClass,
  type PolicyViolationClass,
} from '../moderation/violation-class';

export { POLICY_VIOLATION_CLASSES, isPolicyViolationClass, type PolicyViolationClass };

/** Requirement 26.16's list, by its own name. Same six members, one definition. */
export const PROHIBITED_USE_CLASSES = POLICY_VIOLATION_CLASSES;

export type ProhibitedUseClass = PolicyViolationClass;

/** Design §9.4 — the six, in Korean, for the responsible-use guidance (26.27). */
export const PROHIBITED_USE_LABELS: Readonly<Record<ProhibitedUseClass, string>> = {
  impersonation: '사칭',
  voice_authentication_bypass: '음성 인증 우회',
  fraud: '사기',
  harassment: '괴롭힘',
  nonconsensual_sexual_content: '비동의 성적 콘텐츠',
  misleading_guidance: '오해를 유발하는 정치·법률·금융·의료·긴급 상황 안내',
};

/** Requirement 26.16 — the three texts inspected against the six classes. */
export const PROHIBITED_USE_INSPECTED_FIELDS: readonly ModerationField[] = [
  'dialogue_script',
  'voice_reference_transcript',
  'voice_conversion_profile_designation',
];

export function isProhibitedUseInspectedField(field: ModerationField): boolean {
  return PROHIBITED_USE_INSPECTED_FIELDS.includes(field);
}
