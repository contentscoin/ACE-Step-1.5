import type { EngineAdapter } from '../../adapters/engine-adapter';
import {
  ENGINE_JOB_STATE,
  type EngineJobHandle,
  type EngineJobStatus,
  type HealthCheckResult,
  type RawAudioResult,
} from '../../adapters/engine-job';
import type { NormalizedGenerationRequest } from '../../adapters/normalized-generation';
import type { RefundRequest } from '../../adapters/registry/ports';
import { ProviderRegistry } from '../../adapters/registry/provider-registry';
import type { AssetKind } from '../../domain/asset-kind';
import type { AuditLogDraft } from '../../domain/audit-log/entry';
import { JobOrchestrator } from '../../services/generation/job-orchestrator';
import {
  createInMemoryJobEventBus,
  type JobEventBusPort,
  type JobStatusEvent,
} from '../../services/generation/job-events';
import { createInMemoryJobQueue, type JobQueuePort } from '../../services/generation/job-queue';
import { createInMemoryJobStore, type JobStorePort } from '../../services/generation/job-store';
import type {
  AssetPublicationPort,
  ChargeRequest,
  CreditChargePort,
  EngineStatisticsPort,
} from '../../services/generation/ports';
import type { JobRuntime } from '../../services/generation/runtime';

import {
  createManualScheduler,
  createRecordingAuditSink,
  createScriptedTimeoutRunner,
  engineDescriptor,
  type ManualScheduler,
  type RecordingAuditSink,
  type ScriptedTimeoutRunner,
} from './registry-harness';
import { createMutableClock, type MutableClock } from './mutable-clock';

/**
 * Test rig for the Job_Orchestrator (Requirements 5.1–5.8, 6.1–6.5).
 *
 * Every collaborator is a fake, so the whole of Requirements 5 and 6 is exercised
 * with no Redis, no Postgres and no engine process. Nothing in here sleeps: delays
 * are queued on the manual scheduler and time moves only when a test moves it.
 *
 * `refunds` is deliberately the *same* `CreditRefundPort` the Requirement 20.15
 * remote-call timeout uses, so a test can count refund requests and see that the
 * two timeout paths do not both fire.
 */

export const TEST_ENGINE_ID = 'ace-step-test';

/** Engine adapter whose every response the test scripts. */
export interface ScriptedEngineAdapter extends EngineAdapter {
  /** Queue statuses for successive `poll()` calls. */
  enqueuePoll(...statuses: readonly EngineJobStatus[]): void;
  /** Status returned once the queue is empty. */
  setDefaultPoll(status: EngineJobStatus): void;
  /** Make the next `submit()` calls reject with this error. */
  failSubmit(error: unknown, times?: number): void;
  /** Make the next `poll()` calls reject (Requirement 6.5 unreachable). */
  failPoll(error: unknown, times?: number): void;
  failFetch(error: unknown, times?: number): void;
  setResults(results: readonly RawAudioResult[]): void;
  readonly submitCount: number;
  readonly pollCount: number;
  readonly submitted: readonly NormalizedGenerationRequest[];
  readonly cancelled: readonly EngineJobHandle[];
}

export function createScriptedEngineAdapter(engineId = TEST_ENGINE_ID): ScriptedEngineAdapter {
  const polls: EngineJobStatus[] = [];
  const submitted: NormalizedGenerationRequest[] = [];
  const cancelled: EngineJobHandle[] = [];
  let defaultPoll: EngineJobStatus = { state: ENGINE_JOB_STATE.running };
  let submitFailure: { error: unknown; times: number } | null = null;
  let pollFailure: { error: unknown; times: number } | null = null;
  let fetchFailure: { error: unknown; times: number } | null = null;
  let results: readonly RawAudioResult[] = [
    { audioBuffer: Buffer.from('audio-a'), sampleRate: 44_100, durationMs: 30_000, seed: 7 },
  ];
  let submitCount = 0;
  let pollCount = 0;

  const consume = (slot: { error: unknown; times: number } | null): unknown | undefined => {
    if (slot === null || slot.times <= 0) return undefined;
    slot.times -= 1;
    return slot.error;
  };

  return {
    engineId,
    get submitCount() {
      return submitCount;
    },
    get pollCount() {
      return pollCount;
    },
    get submitted() {
      return submitted;
    },
    get cancelled() {
      return cancelled;
    },

    enqueuePoll(...statuses) {
      polls.push(...statuses);
    },
    setDefaultPoll(status) {
      defaultPoll = status;
    },
    failSubmit(error, times = 1) {
      submitFailure = { error, times };
    },
    failPoll(error, times = 1) {
      pollFailure = { error, times };
    },
    failFetch(error, times = 1) {
      fetchFailure = { error, times };
    },
    setResults(next) {
      results = next;
    },

    async submit(request) {
      submitCount += 1;
      const failure = consume(submitFailure);
      if (failure !== undefined) throw failure;
      submitted.push(request);
      return {
        engineId,
        engineJobId: `${engineId}-job-${String(submitCount)}`,
        submittedAtMs: 0,
      };
    },

    async poll() {
      pollCount += 1;
      const failure = consume(pollFailure);
      if (failure !== undefined) throw failure;
      return polls.shift() ?? defaultPoll;
    },

    async fetchResult() {
      const failure = consume(fetchFailure);
      if (failure !== undefined) throw failure;
      return [...results];
    },

    async healthCheck(): Promise<HealthCheckResult> {
      return { healthy: true, latencyMs: 5 };
    },

    async cancel(handle) {
      cancelled.push(handle);
    },
  };
}

/** Credit port that records every debit and answers with a fixed price. */
export interface RecordingChargePort extends CreditChargePort {
  readonly requests: readonly ChargeRequest[];
  setAmount(amount: number): void;
}

export function createRecordingChargePort(amount = 12): RecordingChargePort {
  const requests: ChargeRequest[] = [];
  let current = amount;

  return {
    requests,
    setAmount(next) {
      current = next;
    },
    charge: async (request) => {
      requests.push(request);
      return { debitedAmount: current };
    },
  };
}

/** Library stand-in for Requirement 5.6: one identifier per result audio. */
export interface RecordingAssetPublication extends AssetPublicationPort {
  readonly published: readonly { readonly jobId: string; readonly count: number }[];
}

export function createRecordingAssetPublication(): RecordingAssetPublication {
  const published: { jobId: string; count: number }[] = [];

  return {
    published,
    publish: async (request) => {
      published.push({ jobId: request.jobId, count: request.results.length });
      return request.results.map((_result, index) => `${request.jobId}-asset-${String(index)}`);
    },
  };
}

export interface CollectingRefundPort {
  readonly requests: readonly RefundRequest[];
  refund(request: RefundRequest): Promise<void>;
}

export function createCollectingRefundPort(): CollectingRefundPort {
  const requests: RefundRequest[] = [];
  return {
    requests,
    refund: async (request) => {
      requests.push(request);
    },
  };
}

export interface GenerationHarness {
  readonly orchestrator: JobOrchestrator;
  readonly runtime: JobRuntime;
  readonly registry: ProviderRegistry;
  readonly adapter: ScriptedEngineAdapter;
  readonly store: JobStorePort;
  readonly queue: JobQueuePort;
  readonly events: JobEventBusPort;
  readonly received: readonly JobStatusEvent[];
  readonly refunds: CollectingRefundPort;
  readonly charges: RecordingChargePort;
  readonly assets: RecordingAssetPublication;
  readonly audit: RecordingAuditSink;
  readonly clock: MutableClock;
  readonly scheduler: ManualScheduler;
  readonly timeoutRunner: ScriptedTimeoutRunner;
  /** Drafts recorded for one job (Requirement 6.3). */
  auditFor(jobId: string): readonly AuditLogDraft[];
}

export interface GenerationHarnessOptions {
  readonly assetKind?: AssetKind;
  readonly averageDurationMs?: number | null;
  readonly startAt?: Date;
  /** Registers no engine, so routing rejects (Requirement 6.6). */
  readonly withoutEngine?: boolean;
  /** Shared with the gateway harness so HTTP and job timing agree. */
  readonly clock?: MutableClock;
  /** Account whose events the harness collects; defaults to `user-1`. */
  readonly accountId?: string;
}

export function createGenerationHarness(
  options: GenerationHarnessOptions = {},
): GenerationHarness {
  const assetKind = options.assetKind ?? 'song';
  const clock =
    options.clock ?? createMutableClock(options.startAt ?? new Date('2025-05-01T00:00:00.000Z'));
  const audit = createRecordingAuditSink();
  const scheduler = createManualScheduler();
  const timeoutRunner = createScriptedTimeoutRunner();
  const refunds = createCollectingRefundPort();
  const charges = createRecordingChargePort();
  const assets = createRecordingAssetPublication();
  const store = createInMemoryJobStore();
  const queue = createInMemoryJobQueue();
  const events = createInMemoryJobEventBus();
  const adapter = createScriptedEngineAdapter();

  const registry = new ProviderRegistry({ clock, auditSink: audit });
  if (options.withoutEngine !== true) {
    const descriptor = engineDescriptor(TEST_ENGINE_ID, {
      supportedAssetKinds: [assetKind],
      maxOutputDurationMs: 600_000,
    });
    registry.register({ descriptor, adapter, actorId: 'operator-1' });
    registry.setDefaultEngine(assetKind, TEST_ENGINE_ID, 'operator-1');
    // Two consecutive successes are what Requirement 20.21 needs to mark an engine
    // available; without them routing would report `no_available_engine`.
    for (let probe = 0; probe < 2; probe += 1) {
      registry.recordHealthOutcome(TEST_ENGINE_ID, {
        outcome: 'success',
        checkedAtMs: clock.now().getTime(),
        latencyMs: 5,
      });
    }
  }

  const average = options.averageDurationMs === undefined ? 60_000 : options.averageDurationMs;
  const statistics: EngineStatisticsPort = { averageDurationMs: () => average };

  let counter = 0;
  const runtime: JobRuntime = {
    registry,
    store,
    queue,
    events,
    refunds,
    charges,
    audit,
    assets,
    statistics,
    clock,
    scheduler,
    timeoutRunner,
    newId: () => {
      counter += 1;
      return `id-${String(counter).padStart(3, '0')}`;
    },
  };

  const received: JobStatusEvent[] = [];
  events.subscribe(options.accountId ?? 'user-1', (event) => received.push(event));

  return {
    orchestrator: new JobOrchestrator(runtime),
    runtime,
    registry,
    adapter,
    store,
    queue,
    events,
    received,
    refunds,
    charges,
    assets,
    audit,
    clock,
    scheduler,
    timeoutRunner,
    auditFor: (jobId) => audit.drafts.filter((draft) => draft.targetId === jobId),
  };
}

/** A minimal submission for the harness's registered engine. */
export function submission(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'user-1',
    assetKind: 'song' as AssetKind,
    inputModality: 'text' as const,
    durationMs: 120_000,
    prompt: 'a calm piano piece',
    ...overrides,
  };
}

/**
 * Runs every task the manual scheduler holds, so a queued backoff or poll delay
 * happens now rather than after real seconds. Bounded, so a self-rearming loop
 * cannot hang the suite.
 */
export async function drainScheduler(scheduler: ManualScheduler, maxTasks = 32): Promise<void> {
  let ran = 0;
  // The queue may still be empty when this is called: the code under test reaches
  // its first `sleepVia` only after several awaits. So an empty queue means "not
  // yet" rather than "done", and the loop yields and looks again — bounded, so a
  // self-rearming schedule cannot hang the suite. It still never waits for time.
  for (let spins = 0; spins < maxTasks * 4 && ran < maxTasks; spins += 1) {
    if (scheduler.runNext()) ran += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
