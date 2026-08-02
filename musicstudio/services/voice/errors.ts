/**
 * Voice_Service failure vocabulary (Requirement 26).
 *
 * Same shape as `services/moderation/errors.ts` and `services/account/errors.ts` —
 * status code, machine-readable `code`, detail bag — so `api/gateway/error-handler.ts`
 * renders it through the existing contract with no second code path.
 *
 * | criterion | status | code |
 * |---|---|---|
 * | 26.13 / 26.26 consent not met | 422 | `voice_consent_incomplete` |
 * | 26.20 not on the share list | 403 | `voice_profile_forbidden` |
 * | 26.19 share list out of bounds | 422 | `voice_share_list_invalid` |
 * | 26.29 profile withdrawn | 403 | `voice_consent_withdrawn` (+ reason code) |
 * | 26.22 profile deleted | 404 | `voice_profile_not_found` |
 * | 26.35 fourth claim in 30 days | 429 | `withdrawal_claim_cap_exceeded` |
 * | inapplicable withdrawal event | 409 | `withdrawal_state_conflict` |
 *
 * 26.20's 403 and 26.22's 404 are deliberately different answers to superficially
 * similar situations, and the difference is the point: 403 says "this profile exists
 * and you may not use it", 404 says "there is no such profile". Collapsing them either
 * leaks the existence of other users' profiles or hides a deletion the caller needs to
 * know about.
 */

import type { ConsentItem } from '../../domain/voice/consent-record';
import type { VoiceProfileConsentState } from '../../domain/voice/consent-state';
import type { WithdrawalRefusalReason } from '../../domain/voice/withdrawal-machine';
import { withdrawalReasonCodeOf } from '../../domain/voice/consent-state';

export type VoiceErrorCode =
  | 'voice_consent_incomplete'
  | 'voice_profile_forbidden'
  | 'voice_share_list_invalid'
  | 'voice_consent_withdrawn'
  | 'voice_profile_not_found'
  | 'withdrawal_claim_cap_exceeded'
  | 'withdrawal_state_conflict';

export type VoiceErrorDetails = Readonly<Record<string, unknown>>;

export class VoiceError extends Error {
  readonly statusCode: number;
  readonly code: VoiceErrorCode;
  readonly details: VoiceErrorDetails;

  constructor(
    statusCode: number,
    code: VoiceErrorCode,
    message: string,
    details: VoiceErrorDetails = {},
  ) {
    super(message);
    this.name = 'VoiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isVoiceError(value: unknown): value is VoiceError {
  return value instanceof VoiceError;
}

/**
 * Requirements 26.13, 26.26 — the unmet consent item names.
 *
 * `creditsCharged: 0` is stated rather than implied: 26.26 requires the balance to be
 * unchanged on refusal, and a client should be able to show that without inferring it
 * from a separate balance call.
 */
export function consentIncomplete(
  unmetItems: readonly ConsentItem[],
  extra: VoiceErrorDetails = {},
): VoiceError {
  return new VoiceError(
    422,
    'voice_consent_incomplete',
    'The Voice_Consent_Record does not satisfy every required consent item.',
    { unmetItems, creditsCharged: 0, ...extra },
  );
}

/** Requirement 26.20 — the caller is neither the owner nor on the share list. */
export function profileForbidden(voiceProfileId: string): VoiceError {
  return new VoiceError(
    403,
    'voice_profile_forbidden',
    'The requesting account is not permitted to use this Voice_Profile.',
    { voiceProfileId },
  );
}

/** Requirement 26.19. */
export function shareListInvalid(details: VoiceErrorDetails): VoiceError {
  return new VoiceError(
    422,
    'voice_share_list_invalid',
    'A shared Voice_Profile must name between 1 and 50 users, excluding the owner.',
    details,
  );
}

/**
 * Requirement 26.29 — 403 plus the withdrawal reason code, no credit charged.
 *
 * The reason code distinguishes an unverified claim from a completed withdrawal, which
 * is what an owner needs in order to decide whether to object (26.36).
 */
export function consentWithdrawn(
  voiceProfileId: string,
  state: VoiceProfileConsentState,
): VoiceError {
  return new VoiceError(
    403,
    'voice_consent_withdrawn',
    'Consent for this Voice_Profile has been withdrawn; generation is refused.',
    {
      voiceProfileId,
      consentState: state,
      withdrawalReasonCode: withdrawalReasonCodeOf(state),
      creditsCharged: 0,
    },
  );
}

/** Requirement 26.22 — a deleted or unknown profile. Same answer for both. */
export function profileNotFound(voiceProfileId: string): VoiceError {
  return new VoiceError(404, 'voice_profile_not_found', 'No such Voice_Profile exists.', {
    voiceProfileId,
  });
}

/** Requirement 26.35 — the cap and the next eligible instant. */
export function withdrawalCapExceeded(details: {
  readonly voiceProfileId: string;
  readonly limit: number;
  readonly countInWindow: number;
  readonly windowDays: number;
  readonly nextEligibleAtMs: number;
}): VoiceError {
  return new VoiceError(
    429,
    'withdrawal_claim_cap_exceeded',
    'This Voice_Profile has reached the withdrawal claim limit for the current window.',
    { ...details },
  );
}

/** The state machine refused the event; the caller asked for something impossible. */
export function withdrawalStateConflict(input: {
  readonly voiceProfileId: string;
  readonly from: VoiceProfileConsentState;
  readonly reason: WithdrawalRefusalReason;
}): VoiceError {
  return new VoiceError(
    409,
    'withdrawal_state_conflict',
    'The withdrawal event does not apply to the profile in its current state.',
    { ...input },
  );
}
