/**
 * The Job_Orchestrator's collaborators, in one place.
 *
 * Submission, polling, the timeout sweep and the cancel/retry paths all need the
 * same set, and every one of them is a port so the whole of Requirements 5 and 6
 * can be exercised with no Redis, no Postgres and no engine.
 *
 * Two entries are reused rather than reinvented, on purpose:
 *
 * - `registry` is the task 1.3 Provider_Registry. Routing, engine availability
 *   (Requirement 6.6) and daily quota all come from it.
 * - `refunds` is the same `CreditRefundPort` the Requirement 20.15 remote-call
 *   timeout already uses, so there is exactly one refund path in the system.
 */

import type { CreditRefundPort, AuditSinkPort } from '../../adapters/registry/ports';
import type { ProviderRegistry } from '../../adapters/registry/provider-registry';
import type { Scheduler } from '../../adapters/registry/health-schedule';
import type { TimeoutRunner } from '../../adapters/timeout-runner';
import type { Clock } from '../clock';

import type { JobEventBusPort } from './job-events';
import type { JobQueuePort } from './job-queue';
import type { JobStorePort } from './job-store';
import type {
  AssetPublicationPort,
  CreditChargePort,
  EngineStatisticsPort,
} from './ports';

export interface JobRuntime {
  readonly registry: ProviderRegistry;
  readonly store: JobStorePort;
  readonly queue: JobQueuePort;
  readonly events: JobEventBusPort;
  /** Requirements 5.7, 5.8, 6.3 — and Requirement 20.15, which shares it. */
  readonly refunds: CreditRefundPort;
  readonly charges: CreditChargePort;
  readonly audit: AuditSinkPort;
  /** Requirement 5.6. */
  readonly assets: AssetPublicationPort;
  /** Requirement 5.5. */
  readonly statistics: EngineStatisticsPort;
  readonly clock: Clock;
  /** Requirements 5.2, 6.2, 6.5 delays; never a bare `setTimeout`. */
  readonly scheduler: Scheduler;
  /** Requirement 20.14's 300 s cap on each engine call. */
  readonly timeoutRunner: TimeoutRunner;
  /** Identifier source for jobs and per-attempt request ids. */
  readonly newId: () => string;
}
