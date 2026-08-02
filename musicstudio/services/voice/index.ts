/**
 * Voice_Service consent surface (design §9.2, §9.3; Requirements 26.12–26.23, 26.26–26.36).
 *
 * Implemented here: 26.12–26.23, 26.26–26.36.
 *
 * **Task 2.7 has since added** Voice_Profile creation (26.1–26.11) and voice conversion
 * (26.24–26.26) alongside it: `profile-service.ts`, `conversion-service.ts`,
 * `profile-ports.ts` and `profile-errors.ts`. Those extend the same `voice_profile` row rather
 * than introducing a second lifecycle flag, and they consume this module's consent machinery —
 * 26.29's refusal reaches them through `ProfileAccessService.assertUsable`, and 26.12/26.26's
 * records through `ConsentService`.
 *
 * Left to other tasks, as narrow ports rather than stubs:
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
export {
  VoiceConversionService,
  type ConvertedVoice,
  type VoiceConversionInput,
  type VoiceConversionOutcomeView,
  type VoiceConversionServiceDependencies,
} from './conversion-service';
export {
  referenceSampleRejected,
  referenceSampleUnreadable,
  voiceConversionFailed,
  voiceConversionLengthUnmet,
  voiceConversionSourceNotFound,
  voiceProfileRequestInvalid,
  REFERENCE_SAMPLE_ALLOWANCE,
  VOICE_PROFILE_ALLOWANCE,
} from './profile-errors';
export type {
  ReferenceProbeOutcome,
  ReferenceSampleProbePort,
  ReferenceSampleStagingPort,
  SourceUtterancePort,
  VoiceConversionOutcome,
  VoiceConversionPort,
  VoiceConversionRequest,
  VoiceProfileRecordStorePort,
  VoicePromptPort,
} from './profile-ports';
export {
  VoiceProfileService,
  type CreateClonedProfileInput,
  type CreatePresetProfileInput,
  type VoiceProfileCreationStatePort,
  type VoiceProfileServiceDependencies,
} from './profile-service';
