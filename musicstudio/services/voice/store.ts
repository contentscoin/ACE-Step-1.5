/**
 * Persistence seams for the consent machinery, backed by
 * `db/migrations/0011_voice_consent.sql`.
 *
 * Split into three ports rather than one repository because the three have different
 * mutability rules, and a single interface would hide that:
 *
 * - `VoiceConsentRecordStorePort` is **append-only**. There is no `update`, so
 *   Requirement 26.14's immutability is not a rule a caller has to remember — it is the
 *   absence of a method. The migration adds the same guarantee in SQL, the way task 1.1
 *   did for the audit log.
 * - `VoiceProfileStatePort` is the one mutable surface, and only for the consent state
 *   and its context. Task 2.7 owns everything else about a Voice_Profile.
 * - `WithdrawalClaimStorePort` appends claims and updates their verification outcome.
 */

import type { VoiceConsentRecord } from '../../domain/voice/consent-record';
import type { VoiceProfileConsentState } from '../../domain/voice/consent-state';
import type { ProfileAccess } from '../../domain/voice/sharing-list';
import type { WithdrawalContext } from '../../domain/voice/withdrawal-machine';

/** Append-only. Requirement 26.14 — stored item values are never modified. */
export interface VoiceConsentRecordStorePort {
  append(record: VoiceConsentRecord): void;
  /** Every record for the profile, oldest first. */
  recordsFor(voiceProfileId: string): readonly VoiceConsentRecord[];
}

/**
 * The consent-state slice of a Voice_Profile.
 *
 * Task 2.7 owns profile creation, the `preset`/`cloned` type, the profile name and the
 * reference samples. The state and its withdrawal context are 6.2's, defined here and
 * in migration 0011 so 2.7 extends the same row rather than inventing a second flag.
 */
export interface VoiceProfileConsentRow {
  readonly voiceProfileId: string;
  readonly ownerId: string;
  readonly context: WithdrawalContext;
  readonly sharedUserIds: readonly string[];
  /** Requirement 26.14's retention origin, and 26.22's 404 condition. */
  readonly deletedAtMs: number | null;
}

export interface VoiceProfileStatePort {
  /** `undefined` for an id that was never created. */
  find(voiceProfileId: string): VoiceProfileConsentRow | undefined;
  saveContext(voiceProfileId: string, context: WithdrawalContext): void;
  saveSharedUserIds(voiceProfileId: string, sharedUserIds: readonly string[]): void;
  markDeleted(voiceProfileId: string, deletedAtMs: number): void;
}

export const WITHDRAWAL_CLAIM_OUTCOMES = ['pending', 'verified', 'rejected', 'expired'] as const;

export type WithdrawalClaimOutcome = (typeof WITHDRAWAL_CLAIM_OUTCOMES)[number];

export interface WithdrawalClaim {
  readonly withdrawalClaimId: string;
  readonly voiceProfileId: string;
  /**
   * The speaker or their agent. `null` when the claim arrived through the contact
   * recorded on a `제3자_허가보유` consent record rather than from a signed-in account —
   * Requirement 26.28 admits both routes, and requiring an account would shut out the
   * third-party speaker the record exists to protect.
   */
  readonly claimantAccountId: string | null;
  /** Requirement 26.28 — which of the two intake routes the claim arrived by. */
  readonly intakeChannel: 'recorded_contact' | 'in_product';
  readonly receivedAtMs: number;
  readonly outcome: WithdrawalClaimOutcome;
}

export interface WithdrawalClaimStorePort {
  append(claim: WithdrawalClaim): void;
  /** Every claim for the profile, for Requirement 26.35's rolling window. */
  claimsFor(voiceProfileId: string): readonly WithdrawalClaim[];
  setOutcome(withdrawalClaimId: string, outcome: WithdrawalClaimOutcome): void;
}

/** Convenience view for the sharing rules (Requirements 26.18–26.20). */
export function accessOf(row: VoiceProfileConsentRow): ProfileAccess {
  return { ownerId: row.ownerId, sharedUserIds: row.sharedUserIds };
}

export function consentStateOf(row: VoiceProfileConsentRow): VoiceProfileConsentState {
  return row.context.state;
}
