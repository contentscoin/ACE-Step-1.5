/**
 * Every deadline Requirement 26 states, as named constants in one place.
 *
 * They are all *clock-injected* durations, never sleeps: the services that consume
 * them add them to a `Clock` reading, so a test advances time instead of waiting for
 * it. That is the only way a 14-day rule is testable at all.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Requirement 26.28 — a withdrawal claim must move the profile to
 * `잠정_사용_제한` within 24 hours of intake.
 *
 * A late transition is an SLA breach to alert on, not a reason to refuse the claim;
 * refusing would let a slow queue defeat the withdrawal. `WithdrawalTransition`
 * therefore reports `withinIntakeWindow` rather than rejecting.
 */
export const WITHDRAWAL_INTAKE_WINDOW_MS = 24 * MS_PER_HOUR;

/**
 * Requirements 26.31, 26.32, 26.34 — the claimant has 14 days from the
 * `잠정_사용_제한` transition to submit identity verification.
 *
 * This is the window the two-stage split exists for. Full takedown on an
 * unverified claim would be a denial-of-service against a legitimate creator;
 * leaving a verified claim unactioned would leave real harm in place. So the
 * profile is frozen for new use immediately and only *withdrawn* once verified.
 */
export const IDENTITY_VERIFICATION_WINDOW_MS = 14 * MS_PER_DAY;

/**
 * Requirements 26.21, 26.32 — reference samples, voice embeddings and cached
 * voice prompts must be erased within 24 hours.
 */
export const VOICE_DATA_ERASURE_WINDOW_MS = 24 * MS_PER_HOUR;

/**
 * Requirement 26.33 — public assets generated with the profile must become
 * private within 24 hours of the `사용_중지` transition.
 */
export const ASSET_UNPUBLISH_WINDOW_MS = 24 * MS_PER_HOUR;

/** Requirement 26.35 — the rolling window for the withdrawal claim cap. */
export const WITHDRAWAL_CLAIM_WINDOW_MS = 30 * MS_PER_DAY;

/** Requirement 26.35 — at most three claims per profile per 30 days. */
export const MAX_WITHDRAWAL_CLAIMS_PER_WINDOW = 3;

/**
 * Requirement 26.14 — a Voice_Consent_Record is retained for five years past the
 * target profile's deletion.
 *
 * Expressed in days, and enforced as a floor rather than a setting, exactly as
 * `domain/audit-log/partition.ts` does for the 365-day audit floor: a shorter
 * retention is a programming error, not a configuration choice. 1826 days is five
 * years with one leap day, the conservative reading of "5년".
 */
export const CONSENT_RECORD_MIN_RETENTION_DAYS = 1_826;

export const CONSENT_RECORD_MIN_RETENTION_MS = CONSENT_RECORD_MIN_RETENTION_DAYS * MS_PER_DAY;
