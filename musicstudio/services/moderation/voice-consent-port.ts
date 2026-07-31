/**
 * Requirement 16.12 — confirm that a Voice_Consent_Record exists for a
 * voice-cloning reference upload.
 *
 * **Scope boundary.** The record itself — its nine mandatory fields (design §9.3),
 * the six prohibited-use classifications, the two-stage withdrawal state machine,
 * and the five-year retention — belongs to **task 6.2**. 16.12 asks Moderation
 * for one thing only: *does a matching record exist*. So that is the whole port.
 *
 * Keeping it this narrow is the point. If this port returned the record,
 * Moderation_Service would end up re-deciding whether the record is still valid,
 * and the withdrawal state machine would then exist in two places.
 *
 * ### Integration point for task 6.2
 *
 * 6.2 implements `VoiceConsentLookupPort` over its consent store. "Matching" is
 * 6.2's definition and must account for the withdrawal state: a profile in
 * `잠정_사용_제한` or `사용_중지` refuses new generation (design §9.2), so the
 * implementation returns `false` for those, and this criterion then blocks the
 * request through the existing `voice_consent_missing` path with no change here.
 */

export interface VoiceConsentQuery {
  /** The Voice_Profile the reference sample is being attached to. */
  readonly voiceProfileId: string;
  /** The account submitting the reference sample. */
  readonly submitterId: string;
}

export interface VoiceConsentLookupPort {
  /** `true` only when a record exists that permits generation right now. */
  hasUsableConsentRecord(query: VoiceConsentQuery): boolean;
}

/**
 * Refuses every voice reference.
 *
 * The default until task 6.2 lands. Failing closed is deliberate: an absent
 * consent store must not read as "consent given".
 */
export const denyingVoiceConsentLookup: VoiceConsentLookupPort = {
  hasUsableConsentRecord: () => false,
};
