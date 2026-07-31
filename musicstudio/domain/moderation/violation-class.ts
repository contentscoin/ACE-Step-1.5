/**
 * Policy violation classification vocabulary (design §9.4).
 *
 * Requirements 16.2 and 16.11 both end with "return the violation
 * classification", so the classification is part of the block payload rather
 * than free text. Design §9.4 states the list once — six prohibited uses — and
 * this module is that list, nothing else.
 *
 * `impersonation` is the classification Requirement 16.11 names explicitly for a
 * dialogue script that speaks as a real person.
 *
 * Scope note: task 6.2 checks a Voice_Consent_Record against these same six
 * categories (Requirement 26.13). That *check* is 6.2's; this module only names
 * the categories so the two do not end up with two divergent spellings of the
 * same design table.
 */

export const POLICY_VIOLATION_CLASSES = [
  /** 사칭 — speaking as, or presenting output as, a real person. */
  'impersonation',
  /** 음성 인증 우회 — defeating a voice-based authentication check. */
  'voice_authentication_bypass',
  /** 사기 — obtaining money, credentials or advantage by deception. */
  'fraud',
  /** 괴롭힘 — targeted abuse or threats. */
  'harassment',
  /** 비동의 성적 콘텐츠 — sexual content involving a person who has not consented. */
  'nonconsensual_sexual_content',
  /** 오해를 유발하는 정치·법률·금융·의료·긴급 상황 안내. */
  'misleading_guidance',
] as const;

export type PolicyViolationClass = (typeof POLICY_VIOLATION_CLASSES)[number];

export function isPolicyViolationClass(value: unknown): value is PolicyViolationClass {
  return (
    typeof value === 'string' && (POLICY_VIOLATION_CLASSES as readonly string[]).includes(value)
  );
}
