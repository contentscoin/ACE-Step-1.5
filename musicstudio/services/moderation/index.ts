/**
 * Moderation_Service public surface (design §9.1; Requirement 16).
 *
 * Implemented here: 16.1, 16.2, 16.3, 16.4, 16.7, 16.8, 16.9, 16.10, 16.11, 16.14.
 * Declared as seams only: 16.12's consent record (task 6.2, `voice-consent-port.ts`)
 * and 16.5/16.6/16.13's labels and watermark (task 8.3, `disclosure-port.ts`).
 */

export { policyBlockedDraft, type PolicyBlockAuditInput } from './audit';
export {
  isApproved,
  rightsConsentBlockFor,
  violationClassesOf,
  type ApprovedModeration,
  type BlockedModeration,
  type InspectedText,
  type ModerationBlock,
  type ModerationDecision,
  type PolicyViolationBlock,
  type RightsConsentBlock,
  type SubstitutionNotice,
  type VoiceConsentBlock,
} from './decision';
export {
  DISCLOSURE_OBLIGATIONS,
  type DisclosureObligation,
  type DisclosurePort,
  type DisclosureTarget,
} from './disclosure-port';
export {
  blockedByModeration,
  isModerationError,
  ModerationError,
  reportTargetNotFound,
  reviewNotOpen,
  type ModerationErrorCode,
} from './errors';
export { withModerationGate, type GatedOutcome } from './generation-gate';
export {
  ModerationService,
  type ModerationRequest,
  type ModerationServiceDependencies,
  type ModerationTextInput,
  type VoiceReferenceDeclaration,
} from './moderation-service';
export {
  permissivePolicyClassifier,
  type PolicyClassificationInput,
  type PolicyClassifierPort,
  type PolicyViolation,
} from './policy-classifier';
export {
  createRuleBasedPolicyClassifier,
  type RuleBasedClassifierOptions,
} from './rule-based-classifier';
export {
  isReportReason,
  REPORT_DETAIL_MAX_LENGTH,
  REPORT_REASONS,
  ReportService,
  type ContentReport,
  type ContentReportDraft,
  type ContentReportStorePort,
  type PublicAssetLookupPort,
  type ReportAcceptance,
  type ReportReason,
  type ReportServiceDependencies,
} from './report-service';
export {
  denyingVoiceConsentLookup,
  type VoiceConsentLookupPort,
  type VoiceConsentQuery,
} from './voice-consent-port';
