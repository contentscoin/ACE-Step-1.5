import type { AuditLogDraft } from '../../domain/audit-log/entry';
import type { AssetReviewState } from '../../domain/moderation/review-state';
import { INITIAL_REVIEW_STATE } from '../../domain/moderation/review-state';
import { ModerationService } from '../../services/moderation/moderation-service';
import type { ModerationServiceDependencies } from '../../services/moderation/moderation-service';
import { createRuleBasedPolicyClassifier } from '../../services/moderation/rule-based-classifier';
import { ReportService } from '../../services/moderation/report-service';
import type {
  ContentReport,
  ContentReportStorePort,
  PublicAssetLookupPort,
} from '../../services/moderation/report-service';
import type { VoiceConsentLookupPort } from '../../services/moderation/voice-consent-port';

import { createMutableClock, type MutableClock } from './mutable-clock';
import { createRecordingAuditSink, type RecordingAuditSink } from './registry-harness';

/**
 * Fakes for the Moderation_Service ports (Requirement 16).
 *
 * The audit sink is task 1.3's `RecordingAuditSink`, reused rather than
 * reimplemented: Requirement 16.7 writes to the same Audit_Log as every other
 * auditable event, so a second recorder would be a second definition of "recorded".
 */

/** In-memory `content_report` + `audio_asset.review_state`, per migration 0009. */
export interface InMemoryContentReportStore extends ContentReportStorePort {
  readonly all: readonly ContentReport[];
  reviewStates(): ReadonlyMap<string, AssetReviewState>;
}

export function createInMemoryContentReportStore(): InMemoryContentReportStore {
  const reports: ContentReport[] = [];
  const states = new Map<string, AssetReviewState>();

  return {
    all: reports,
    append: (report) => {
      reports.push(report);
    },
    reportsFor: (assetId) => reports.filter((report) => report.assetId === assetId),
    reviewStateOf: (assetId) => states.get(assetId) ?? INITIAL_REVIEW_STATE,
    setReviewState: (assetId, state) => {
      states.set(assetId, state);
    },
    reviewStates: () => states,
  };
}

/** Stands in for Sharing_Service (task 5.3): which assets are publicly visible. */
export interface ConfigurablePublicAssets extends PublicAssetLookupPort {
  publish(assetId: string): void;
  unpublish(assetId: string): void;
}

export function createConfigurablePublicAssets(
  published: readonly string[] = [],
): ConfigurablePublicAssets {
  const visible = new Set(published);
  return {
    isPubliclyVisible: (assetId) => visible.has(assetId),
    publish: (assetId) => {
      visible.add(assetId);
    },
    unpublish: (assetId) => {
      visible.delete(assetId);
    },
  };
}

/** Stands in for task 6.2's consent store. Nothing consented unless told. */
export interface ConfigurableVoiceConsent extends VoiceConsentLookupPort {
  grant(voiceProfileId: string, submitterId: string): void;
}

export function createConfigurableVoiceConsent(): ConfigurableVoiceConsent {
  const granted = new Set<string>();
  return {
    grant: (voiceProfileId, submitterId) => {
      granted.add(`${voiceProfileId}\u0000${submitterId}`);
    },
    hasUsableConsentRecord: ({ voiceProfileId, submitterId }) =>
      granted.has(`${voiceProfileId}\u0000${submitterId}`),
  };
}

export interface ModerationHarness {
  readonly moderation: ModerationService;
  readonly reports: ReportService;
  readonly store: InMemoryContentReportStore;
  readonly publicAssets: ConfigurablePublicAssets;
  readonly voiceConsent: ConfigurableVoiceConsent;
  readonly audit: RecordingAuditSink;
  readonly clock: MutableClock;
  /** Audit drafts of the `policy_blocked` type only (Requirement 16.7). */
  policyBlocks(): readonly AuditLogDraft[];
}

export interface ModerationHarnessOptions {
  readonly publishedAssetIds?: readonly string[];
  readonly startAt?: Date;
  readonly classifier?: ModerationServiceDependencies['classifier'];
}

export function createModerationHarness(
  options: ModerationHarnessOptions = {},
): ModerationHarness {
  const clock = createMutableClock(options.startAt ?? new Date('2025-04-01T12:00:00.000Z'));
  const audit = createRecordingAuditSink();
  const store = createInMemoryContentReportStore();
  const publicAssets = createConfigurablePublicAssets(options.publishedAssetIds ?? []);
  const voiceConsent = createConfigurableVoiceConsent();

  const moderation = new ModerationService({
    classifier: options.classifier ?? createRuleBasedPolicyClassifier(),
    clock,
    auditSink: audit,
    voiceConsent,
  });

  let reportSequence = 0;
  const reports = new ReportService({
    store,
    publicAssets,
    clock,
    newReportId: () => `report-${String(++reportSequence)}`,
  });

  return {
    moderation,
    reports,
    store,
    publicAssets,
    voiceConsent,
    audit,
    clock,
    policyBlocks: () => audit.drafts.filter((draft) => draft.eventType === 'policy_blocked'),
  };
}
