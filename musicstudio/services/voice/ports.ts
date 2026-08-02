/**
 * Narrow outbound ports of the Voice_Service consent machinery.
 *
 * Each is the seam to something task 6.2 does not build, kept to the one question
 * Requirement 26 actually asks — the same discipline `adapters/registry/ports.ts` and
 * `services/moderation/voice-consent-port.ts` already established here.
 *
 * | port | owner | criteria |
 * |---|---|---|
 * | `IdentityVerificationPort` | operations / a vendor | 26.31, 26.32, 26.34 |
 * | `GeneratedAssetVisibilityPort` | Sharing_Service, **task 5.3** | 26.30, 26.33 |
 * | `VoiceDataErasurePort` | storage / embedding cache | 26.21, 26.32 |
 * | `WithdrawalNotificationPort` | notification transport | 26.28, 26.33, 26.34 |
 * | `OperatorReviewPort` | Admin_Console, task 8.2 | 26.36 |
 */

import type { VoiceConsentRecord } from '../../domain/voice/consent-record';

/**
 * Requirement 26.31 — identity verification of the withdrawal claimant.
 *
 * The criterion accepts one of two artefacts: a recording of a designated challenge
 * phrase, or a document proving the speaker's identity. **This port deliberately does
 * not do biometric matching.** Voice-to-voice matching is a different system with its
 * own accuracy, bias and retention problems, and 26.31 does not ask for it — it asks
 * for a submission and a verdict. Whoever supplies the verdict, human or vendor,
 * implements this.
 *
 * The verdict is a plain three-way value rather than a score, because 26.32 and 26.34
 * branch on exactly three outcomes and a threshold here would put the policy decision
 * in the adapter.
 */
export const IDENTITY_EVIDENCE_KINDS = [
  /** 26.31 — 지정된 확인 문구를 낭독한 음성. */
  'challenge_phrase_recording',
  /** 26.31 — 화자 신원을 증명하는 문서. */
  'identity_document',
] as const;

export type IdentityEvidenceKind = (typeof IDENTITY_EVIDENCE_KINDS)[number];

export interface IdentityEvidenceSubmission {
  readonly withdrawalClaimId: string;
  readonly kind: IdentityEvidenceKind;
  /** Opaque handle to the uploaded artefact. Never its bytes. */
  readonly evidenceRef: string;
  readonly submittedAtMs: number;
}

export type IdentityVerdict = 'verified' | 'rejected' | 'pending';

export interface IdentityVerificationPort {
  verify(submission: IdentityEvidenceSubmission): IdentityVerdict;
}

/** Refuses everything. The safe default: an absent verifier is not a verification. */
export const rejectingIdentityVerification: IdentityVerificationPort = {
  verify: () => 'rejected',
};

/**
 * Requirements 26.30 and 26.33 — Sharing_Service's asset visibility, narrowed.
 *
 * **Task 5.3 owns Sharing_Service**; this is the entire surface 6.2 needs from it.
 * `publicAssetIdsFor` exists so 26.33 can report "대상 자산 식별자 목록" to the owner,
 * and `makePrivate` is the only mutation — there is no `makePublic`, because no
 * criterion in Requirement 26 ever republishes an asset. A restore under 26.34 has
 * nothing to undo precisely because the provisional stage never called this.
 */
export interface GeneratedAssetVisibilityPort {
  /** Public assets generated with the profile, at the moment of the call. */
  publicAssetIdsFor(voiceProfileId: string): readonly string[];
  /** Requirement 26.33 — turn them private by `dueAtMs`. */
  makePrivate(assetIds: readonly string[], dueAtMs: number): void;
}

/**
 * Requirements 26.21 and 26.32 — erase the profile's reference data.
 *
 * One call for all three data classes the criteria name (reference sample files, voice
 * embeddings, cached voice prompts) because they share a deadline and must not be
 * partially erased. Requirement 26.23's already-generated Audio_Assets are *not* in
 * scope and there is no parameter that could bring them into it.
 */
export interface VoiceDataErasurePort {
  eraseReferenceData(voiceProfileId: string, dueAtMs: number): void;
}

export const WITHDRAWAL_NOTICE_KINDS = [
  /** 26.28 — intake accepted, plus how to object. */
  'withdrawal_received',
  /** 26.33 — assets made private, with the reason and the id list. */
  'assets_made_private',
  /** 26.34 — the profile was restored. */
  'withdrawal_reverted',
] as const;

export type WithdrawalNoticeKind = (typeof WITHDRAWAL_NOTICE_KINDS)[number];

export interface WithdrawalNotice {
  readonly kind: WithdrawalNoticeKind;
  /** `owner` or `claimant`; 26.34 notifies both. */
  readonly audience: 'owner' | 'claimant';
  readonly voiceProfileId: string;
  readonly withdrawalClaimId: string | null;
  /** Requirement 26.33's 대상 자산 식별자 목록, when the notice carries one. */
  readonly assetIds?: readonly string[];
  /** Requirement 26.28's 이의 제기 방법, when the notice carries one. */
  readonly objectionUrl?: string;
  readonly sentAtMs: number;
}

export interface WithdrawalNotificationPort {
  notify(notice: WithdrawalNotice): void;
}

export const noopWithdrawalNotifications: WithdrawalNotificationPort = {
  notify: () => undefined,
};

/**
 * Requirement 26.36 — the review item handed to an operator.
 *
 * It carries the consent record *and* the objection together, because that is what the
 * criterion requires and because an operator judging an objection without the record it
 * disputes cannot reach a decision. Task 8.2's Admin_Console renders it.
 */
export interface OperatorReviewItem {
  readonly reviewItemId: string;
  readonly voiceProfileId: string;
  readonly withdrawalClaimId: string;
  readonly ownerId: string;
  readonly objection: string;
  /** Every consent record for the profile — 26.14 keeps them all. */
  readonly consentRecords: readonly VoiceConsentRecord[];
  readonly submittedAtMs: number;
}

export interface OperatorReviewPort {
  submit(item: OperatorReviewItem): void;
}
