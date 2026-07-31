/**
 * Voice_Service consent surface (design §9.2, §9.3; Requirements 26.12–26.23, 26.26–26.36).
 *
 * Implemented here: 26.12–26.23, 26.26–26.36.
 *
 * Left to other tasks, as narrow ports rather than stubs:
 * - **task 2.7** — Voice_Profile creation, the `preset`/`cloned` type, reference-sample
 *   validation and Speech_Service. The consent *state* is defined here (see
 *   `store.ts`, `domain/voice/consent-state.ts`) so 2.7 extends the same row; 26.29's
 *   refusal reaches Speech_Service through `ProfileAccessService.assertUsable` and
 *   through `createVoiceConsentLookup`.
 * - **task 5.3** — Sharing_Service. 26.30's preservation and 26.33's unpublishing depend
 *   on `GeneratedAssetVisibilityPort` and nothing wider.
 * - **task 8.2** — Admin_Console. 26.36's review item arrives through `OperatorReviewPort`.
 */

export {
  assetsMadePrivateDraft,
  consentRecordedDraft,
  objectionDraft,
  profileDeletedDraft,
  sharingChangedDraft,
  withdrawalTransitionDraft,
} from './audit';
export { createVoiceConsentLookup, type VoiceConsentLookupDependencies } from './consent-lookup';
export {
  ConsentService,
  type ConsentIntake,
  type ConsentServiceDependencies,
} from './consent-service';
export {
  consentIncomplete,
  consentWithdrawn,
  isVoiceError,
  profileForbidden,
  profileNotFound,
  shareListInvalid,
  VoiceError,
  withdrawalCapExceeded,
  withdrawalStateConflict,
  type VoiceErrorCode,
} from './errors';
export {
  IDENTITY_EVIDENCE_KINDS,
  noopWithdrawalNotifications,
  rejectingIdentityVerification,
  WITHDRAWAL_NOTICE_KINDS,
  type GeneratedAssetVisibilityPort,
  type IdentityEvidenceKind,
  type IdentityEvidenceSubmission,
  type IdentityVerdict,
  type IdentityVerificationPort,
  type OperatorReviewItem,
  type OperatorReviewPort,
  type VoiceDataErasurePort,
  type WithdrawalNotice,
  type WithdrawalNoticeKind,
  type WithdrawalNotificationPort,
} from './ports';
export {
  ProfileAccessService,
  type ProfileAccessServiceDependencies,
  type ProfileDeletionResult,
} from './profile-access-service';
export {
  RESPONSIBLE_USE_GUIDE_PATH,
  responsibleUseGuidance,
  type ProhibitedUseSummary,
  type ResponsibleUseGuidance,
} from './responsible-use';
export {
  accessOf,
  consentStateOf,
  WITHDRAWAL_CLAIM_OUTCOMES,
  type VoiceConsentRecordStorePort,
  type VoiceProfileConsentRow,
  type VoiceProfileStatePort,
  type WithdrawalClaim,
  type WithdrawalClaimOutcome,
  type WithdrawalClaimStorePort,
} from './store';
export {
  WithdrawalService,
  type WithdrawalIntakeRequest,
  type WithdrawalIntakeResult,
  type WithdrawalServiceDependencies,
} from './withdrawal-service';
