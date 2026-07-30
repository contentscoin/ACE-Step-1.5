/**
 * Provider_Registry public surface (design §3.2–§3.6).
 *
 * Callers outside `adapters/` import from here so the module layout inside the
 * registry stays free to change.
 */

export { ProviderRegistry, healthSummaryOf } from './provider-registry';
export type {
  EngineListing,
  HealthOutcomeRecorded,
  ProviderRegistryOptions,
  RegistrationInput,
  RegistrationResult,
} from './provider-registry';

export { routeGenerationRequest } from './routing';
export type { RoutingDecision, RoutingRequest, SubstitutionReason } from './routing';

export { selectionCatalogueFor } from './selection-catalogue';
export type { SelectionEntry } from './selection-catalogue';

export { createHealthMonitor } from './health-monitor';
export type { HealthMonitor, HealthMonitorOptions } from './health-monitor';

export {
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_JITTER_MS,
  HEALTH_CHECK_MAX_INTERVAL_MS,
  HEALTH_CHECK_MIN_INTERVAL_MS,
  isWithinCheckTolerance,
  nextCheckDelayMs,
  realScheduler,
} from './health-schedule';
export type { Scheduler, ScheduledTask } from './health-schedule';

export {
  CONSECUTIVE_FAILURES_TO_UNAVAILABLE,
  CONSECUTIVE_SUCCESSES_TO_AVAILABLE,
  applyHealthOutcome,
  foldHealthOutcomes,
  initialAvailabilityState,
} from './health-transitions';
export type { AvailabilityState, AvailabilityTransition, EngineAvailability } from './health-transitions';

export {
  HEALTH_HISTORY_MIN_ENTRIES,
  HEALTH_HISTORY_RETENTION_MS,
  createHealthHistory,
  recordsWithinRetentionWindow,
} from './health-history';
export type { HealthCheckOutcome, HealthCheckRecord, HealthHistory } from './health-history';

export {
  createQuotaLedger,
  nextQuotaResetAtMs,
  utcDayStartMs,
} from './quota-ledger';
export type { QuotaCheck, QuotaLedger, QuotaLimits, QuotaRequirement, QuotaUsage } from './quota-ledger';

export { callRemoteEngine, REFUND_DEADLINE_MS } from './remote-call';
export type { RemoteCallOutcome, RemoteTimeoutRecord } from './remote-call';

export {
  ENGINE_ASSIGNMENTS,
  createEngineAssignmentTable,
  ACE_STEP_ENGINE_ID,
  WOOSH_FLOW_ENGINE_ID,
  TTS_PRIMARY_ENGINE_ID,
  TTS_SECONDARY_ENGINE_ID,
  MIXDOWN_RENDERER_ENGINE_ID,
} from './default-engines';
export type { EngineAssignment, EngineAssignmentTable } from './default-engines';

export { validateEngineDescriptor, isValidEngineDescriptor } from './descriptor-validation';
export type { DailyQuota, EngineDescriptor, ExecutionLocation } from './engine-descriptor';
export { EXECUTION_LOCATIONS, supportsAssetKind, supportsInputModality } from './engine-descriptor';

export { validateLicenseDescriptor, LICENSE_FIELD_NAMES } from './license-descriptor';
export type { LicenseDescriptor } from './license-descriptor';

export {
  DEFAULT_NON_COMMERCIAL_LICENSE_IDS,
  createNonCommercialLicenseList,
  ruleCommercialUse,
} from './non-commercial-licenses';
export type { CommercialUseRuling, NonCommercialLicenseList } from './non-commercial-licenses';

export { isSelectable, snapshotOf } from './engine-record';
export type { EngineActivation, EngineRecord, EngineStateSnapshot } from './engine-record';

export { RegistryError, isRegistryError } from './errors';
export type { EngineHealthSummary, RegistryErrorCode } from './errors';

export { noopAuditSink, permissivePricingPort } from './ports';
export type { AuditSinkPort, CreditRefundPort, EnginePricingPort, RefundRequest } from './ports';

export { engineAuditDraft, engineAuditEntry } from './audit';
export type { EngineAuditChange } from './audit';
