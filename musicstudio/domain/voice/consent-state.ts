/**
 * Voice_Profile consent state (design §9.2).
 *
 * The state names are the design's, spelled in Korean, because §9.2 names them
 * that way and every criterion in Requirement 26 refers to them by those names.
 * Translating them here would put a glossary between the requirement text and the
 * code for no gain.
 *
 * §9.2 draws three states and a terminal sink:
 *
 * ```
 *   [*] ──► 정상 ──철회 접수──► 잠정_사용_제한 ──확인 성공──► 사용_중지 ──삭제 완료──► [*]
 *                                    │
 *                                    └──확인 실패 / 14일 미제출──► 정상
 * ```
 *
 * The sink is spelled `삭제됨` rather than left anonymous, because Requirement 26.22
 * attaches an observable behaviour to it — a request naming a deleted profile answers
 * **404** — and that is a different answer from `사용_중지`, which answers **403**
 * with a withdrawal reason code (26.29). A single "gone" state would collapse the two
 * and leak which profiles once existed.
 *
 * Ownership note: task 2.7 owns Voice_Profile creation and the `preset`/`cloned`
 * type. This state field is 6.2's, defined here so 2.7 builds on it rather than
 * inventing a second lifecycle flag.
 */

export const VOICE_PROFILE_CONSENT_STATES = [
  /** Usable. Requirement 26.18's owner permission applies. */
  '정상',
  /** Requirement 26.28 — a withdrawal claim is open, identity unverified. */
  '잠정_사용_제한',
  /** Requirement 26.32 — identity verified; the profile is withdrawn. */
  '사용_중지',
  /** Requirement 26.21/26.23 — reference data erased; 26.22's 404 state. */
  '삭제됨',
] as const;

export type VoiceProfileConsentState = (typeof VOICE_PROFILE_CONSENT_STATES)[number];

export const INITIAL_CONSENT_STATE: VoiceProfileConsentState = '정상';

export function isVoiceProfileConsentState(value: unknown): value is VoiceProfileConsentState {
  return (
    typeof value === 'string' &&
    (VOICE_PROFILE_CONSENT_STATES as readonly string[]).includes(value)
  );
}

/**
 * Requirement 26.29 — the two states in which dialogue generation and voice
 * conversion are refused with 403 and a withdrawal reason code.
 *
 * This is the single predicate the `VoiceConsentLookupPort` implementation and the
 * Speech_Service refusal both read, so "refused because of a withdrawal" has one
 * definition.
 */
export function refusesGenerationForWithdrawal(state: VoiceProfileConsentState): boolean {
  return state === '잠정_사용_제한' || state === '사용_중지';
}

/** Requirement 26.22 — a deleted profile is 404, never 403. */
export function isProfileDeleted(state: VoiceProfileConsentState): boolean {
  return state === '삭제됨';
}

/**
 * Requirement 26.29 — the reason code that travels with the 403.
 *
 * Distinct per state on purpose: a claimant's unverified claim and a verified
 * withdrawal are different facts, and an owner deciding whether to object (26.36)
 * needs to tell them apart.
 */
export const WITHDRAWAL_REASON_CODES = {
  잠정_사용_제한: 'consent_withdrawal_pending_verification',
  사용_중지: 'consent_withdrawn',
} as const;

export type WithdrawalReasonCode =
  (typeof WITHDRAWAL_REASON_CODES)[keyof typeof WITHDRAWAL_REASON_CODES];

export function withdrawalReasonCodeOf(
  state: VoiceProfileConsentState,
): WithdrawalReasonCode | null {
  if (state === '잠정_사용_제한') return WITHDRAWAL_REASON_CODES.잠정_사용_제한;
  if (state === '사용_중지') return WITHDRAWAL_REASON_CODES.사용_중지;
  return null;
}
