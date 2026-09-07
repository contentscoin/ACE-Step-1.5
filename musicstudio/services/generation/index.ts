/**
 * Job_Orchestrator public surface (design §2.3, §3.4).
 *
 * Implemented here: Requirements 5.1–5.8 and 6.1–6.5.
 *
 * Requirement 6.6 is satisfied by delegation, not by code in this folder: the
 * "every engine for this Asset_Kind is unhealthy" condition is the
 * Provider_Registry's availability state, and its 503 `no_available_engine`
 * rejection is the maintenance notice.
 *
 * Declared as seams only: the credit debit (`CreditChargePort`, task 1.4), the
 * Audio_Asset creation of Requirement 5.6 (`AssetPublicationPort`, task 5.1) and
 * the engine's reported average duration (`EngineStatisticsPort`).
 *
 * Also implemented here: Requirement 7's Edit_Task gateway and its Requirement 7.12
 * lineage, whose source-audio resolution and lineage persistence are declared as two
 * further Library_Service seams (`EditSourceAudioPort`, `EditLineagePort`).
 */

export { jobFailedDraft, type JobFailureAuditInput } from './audit';
export {
  GENERATION_JOB_QUEUE_NAME,
  bullMqJobOptions,
  createBullMqJobQueue,
  type BullJobOptions,
  type BullQueueHandle,
} from './bullmq-queue';
export {
  EditGateway,
  type EditGatewayOptions,
  type EditModerationContext,
  type EditSubmissionInput,
  type EditSubmissionResult,
} from './edit-gateway';
export {
  editLineageRejected,
  editRequestInvalid,
  editSourceAssetNotFound,
  editTaskUnsupported,
} from './edit-errors';
export {
  createInMemoryEditLineage,
  editLineageEdges,
  recordEditLineage,
  withEditLineage,
  type EditLineageInput,
  type EditLineageRecording,
  type InMemoryEditLineage,
  type RecordEditLineageInput,
} from './edit-lineage';
export type {
  EditLineagePort,
  EditSourceAudioPort,
  EditSourceAudioQuery,
  EditSourceAudioRecord,
} from './edit-ports';
export {
  USER_VISIBLE_STATE_FOR_ENGINE_STATE,
  lifecycleEventFor,
} from './engine-status';
export { submitWithRetry, type SubmissionAttempt, type SubmissionOutcome } from './engine-submission';
export {
  GenerationError,
  isGenerationError,
  jobForbidden,
  jobNotCancellable,
  jobNotFound,
  jobNotRetryable,
  type GenerationErrorCode,
} from './errors';
export {
  SSE_DELIVERY_BUDGET_MS,
  createInMemoryJobEventBus,
  deliveryDeadlineMs,
  isWithinDeliveryBudget,
  type JobEventBusPort,
  type JobEventListener,
  type JobStatusEvent,
  type Unsubscribe,
} from './job-events';
export {
  JobOrchestrator,
  type JobAcceptance,
  type SubmitJobInput,
  type SubmitOutcome,
} from './job-orchestrator';
export { pollJobOnce, schedulePolling, type PollResult } from './job-poller';
export { createInMemoryJobQueue, type JobQueuePort, type QueuePlacement } from './job-queue';
export {
  createJobRecord,
  retryRequestOf,
  type GenerationJobInput,
  type GenerationJobRecord,
  type NewJobInput,
} from './job-record';
export { jobStatusEvent, jobStatusView, type JobStatusView } from './job-status';
export { createInMemoryJobStore, type JobStorePort } from './job-store';
export {
  applyJobEvent,
  type AppliedJobEvent,
  type ApplyJobEventOptions,
} from './job-transitions';
export {
  freeChargePort,
  freeRefundPort,
  noEngineStatistics,
  type AssetPublicationPort,
  type AssetPublicationRequest,
  type ChargeOutcome,
  type ChargeRequest,
  type CreditChargePort,
  type EngineStatisticsPort,
} from './ports';
export type { JobRuntime } from './runtime';
export {
  SelfPollingJobOrchestrator,
  startTimeoutSweep,
  type SelfPollingOptions,
} from './self-polling-orchestrator';
export { sleepVia } from './scheduling';
export { isOverdue, sweepTimedOutJobs, type SweepResult } from './timeout-sweep';
