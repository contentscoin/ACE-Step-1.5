import type { EngineDescriptor } from '../../adapters/registry/engine-descriptor';
import type { LicenseDescriptor } from '../../adapters/registry/license-descriptor';
import type {
  AuditSinkPort,
  CreditRefundPort,
  EngineAdapterFactoryPort,
  EnginePricingPort,
  RefundRequest,
} from '../../adapters/registry/ports';
import { ProviderRegistry } from '../../adapters/registry/provider-registry';
import { createEngineAssignmentTable } from '../../adapters/registry/default-engines';
import type { EngineAssignment } from '../../adapters/registry/default-engines';
import type { TimeoutOutcome, TimeoutRunner } from '../../adapters/timeout-runner';
import type { Scheduler, ScheduledTask } from '../../adapters/registry/health-schedule';
import type { AssetKind } from '../../domain/asset-kind';
import type { AuditLogDraft } from '../../domain/audit-log/entry';

import { createFakeEngineAdapter, type FakeEngineAdapter } from './fake-engine-adapter';
import { createMutableClock, type MutableClock } from './mutable-clock';

/** Fakes for the three narrow registry ports plus a controllable timeout runner. */

export interface RecordingAuditSink extends AuditSinkPort {
  readonly drafts: readonly AuditLogDraft[];
  changesFor(engineId: string): readonly string[];
}

export function createRecordingAuditSink(): RecordingAuditSink {
  const drafts: AuditLogDraft[] = [];

  return {
    drafts,
    record: (draft) => {
      drafts.push(draft);
    },
    changesFor(engineId) {
      return drafts
        .filter((draft) => draft.targetId === engineId)
        .map((draft) => {
          const after = draft.afterValue as { change?: string } | null;
          return after?.change ?? draft.eventType;
        });
    },
  };
}

export interface ConfigurablePricingPort extends EnginePricingPort {
  /** Marks `engineId` as having no pricing entry for the given kinds. */
  omit(engineId: string, assetKinds?: readonly AssetKind[]): void;
}

export function createConfigurablePricingPort(): ConfigurablePricingPort {
  const omitted = new Map<string, readonly AssetKind[] | 'all'>();

  return {
    omit(engineId, assetKinds) {
      omitted.set(engineId, assetKinds ?? 'all');
    },
    missingPricingKeys(engineId, assetKinds) {
      const entry = omitted.get(engineId);
      if (entry === undefined) return [];
      const kinds = entry === 'all' ? assetKinds : assetKinds.filter((kind) => entry.includes(kind));
      return kinds.map((kind) => `${kind}:${engineId}`);
    },
  };
}

export interface RecordingRefundPort extends CreditRefundPort {
  readonly requests: readonly RefundRequest[];
}

export function createRecordingRefundPort(): RecordingRefundPort {
  const requests: RefundRequest[] = [];
  return {
    requests,
    refund: async (request) => {
      requests.push(request);
    },
  };
}

/**
 * A credit ledger that fails the test if anything debits it.
 *
 * Requirements 20.11, 20.13 and 20.22 all end with "the credit balance stays at
 * its pre-request value". Credit_Service is task 1.4, so the assertion is made
 * against this stand-in: routing has no reference to it, and any future debit on
 * a rejection path would surface as a thrown error here.
 */
export interface FrozenCreditBalance {
  readonly balance: number;
  debit(amount: number): never;
}

export function createFrozenCreditBalance(balance: number): FrozenCreditBalance {
  return {
    balance,
    debit(amount) {
      throw new Error(`credit balance must stay unchanged, but a debit of ${String(amount)} was attempted`);
    },
  };
}

/**
 * Timeout runner whose verdict the test decides.
 *
 * `run` never waits: it either awaits the operation or reports `timed_out`
 * immediately, so the 10 s (20.7) and 300 s (20.14) budgets are asserted without
 * a test spending either.
 */
export interface ScriptedTimeoutRunner extends TimeoutRunner {
  /** Make the next `count` calls report a timeout. */
  timeOutNext(count?: number): void;
  readonly observedBudgetsMs: readonly number[];
}

export function createScriptedTimeoutRunner(): ScriptedTimeoutRunner {
  const observedBudgetsMs: number[] = [];
  let pendingTimeouts = 0;

  return {
    observedBudgetsMs,
    timeOutNext(count = 1) {
      pendingTimeouts += count;
    },
    async run<T>(operation: () => Promise<T>, budgetMs: number): Promise<TimeoutOutcome<T>> {
      observedBudgetsMs.push(budgetMs);
      if (pendingTimeouts > 0) {
        pendingTimeouts -= 1;
        // The operation is started, as production does, but not awaited.
        void operation().catch(() => undefined);
        return { kind: 'timed_out', budgetMs };
      }
      try {
        return { kind: 'completed', value: await operation() };
      } catch (error) {
        return { kind: 'failed', error };
      }
    },
  };
}

/**
 * Drains the microtask queue.
 *
 * A scheduled probe cycle is fire-and-forget (`void checkAll()`), so a test that
 * runs the queued task has to let the resulting promise chain finish before
 * asserting. Every fake in this file settles without I/O or timers, so the whole
 * chain completes before this `setImmediate` callback runs — the test waits for
 * work to finish, never for time to pass.
 */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Scheduler that queues tasks until the test runs them. No timers involved. */
export interface ManualScheduler extends Scheduler {
  readonly pendingDelaysMs: readonly number[];
  /** Runs the earliest queued task. Returns false when the queue is empty. */
  runNext(): boolean;
}

export function createManualScheduler(): ManualScheduler {
  const queue: { delayMs: number; task: () => void; cancelled: boolean }[] = [];

  return {
    get pendingDelaysMs() {
      return queue.filter((entry) => !entry.cancelled).map((entry) => entry.delayMs);
    },
    after(delayMs, task): ScheduledTask {
      const entry = { delayMs, task, cancelled: false };
      queue.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    runNext() {
      const entry = queue.shift();
      if (entry === undefined) return false;
      if (entry.cancelled) return this.runNext();
      entry.task();
      return true;
    },
  };
}

/** A License_Descriptor that satisfies every Requirement 33.1 item. */
export function permissiveLicense(overrides: Partial<LicenseDescriptor> = {}): LicenseDescriptor {
  return {
    codeLicenseId: 'Apache-2.0',
    weightLicenseId: 'Apache-2.0',
    commercialUseAllowed: true,
    attributionText: 'Powered by a test engine',
    licenseUrls: ['https://example.test/license'],
    ...overrides,
  };
}

export function engineDescriptor(
  engineId: string,
  overrides: Partial<EngineDescriptor> = {},
): EngineDescriptor {
  return {
    engineId,
    supportedAssetKinds: ['song', 'bgm'],
    supportedInputModalities: ['text'],
    maxOutputDurationMs: 240_000,
    sampleRate: 44_100,
    executionLocation: 'remote',
    license: permissiveLicense(),
    dailyQuota: { maxRequests: 100, maxGpuSeconds: 1_000 },
    ...overrides,
  };
}

export interface RegistryHarnessOptions {
  readonly assignments?: Partial<Record<AssetKind, EngineAssignment>>;
  readonly startAt?: Date;
}

export interface RegistryHarness {
  readonly registry: ProviderRegistry;
  readonly clock: MutableClock;
  readonly audit: RecordingAuditSink;
  readonly pricing: ConfigurablePricingPort;
  readonly adapters: Map<string, FakeEngineAdapter>;
  readonly adapterFactory: EngineAdapterFactoryPort;
  /** Registers an engine with a fresh fake adapter and returns that adapter. */
  register(descriptor: EngineDescriptor, actorId?: string): FakeEngineAdapter;
}

export function createRegistryHarness(options: RegistryHarnessOptions = {}): RegistryHarness {
  const clock = createMutableClock(options.startAt ?? new Date('2025-03-01T09:00:00.000Z'));
  const audit = createRecordingAuditSink();
  const pricing = createConfigurablePricingPort();
  const adapters = new Map<string, FakeEngineAdapter>();

  const assignments = createEngineAssignmentTable();
  for (const [assetKind, assignment] of Object.entries(options.assignments ?? {})) {
    assignments.set(assetKind as AssetKind, assignment);
  }

  const registry = new ProviderRegistry({ clock, auditSink: audit, pricing, assignments });

  const adapterFactory: EngineAdapterFactoryPort = {
    create(descriptor) {
      const existing = adapters.get(descriptor.engineId);
      if (existing !== undefined) return existing;
      const adapter = createFakeEngineAdapter({ engineId: descriptor.engineId });
      adapters.set(descriptor.engineId, adapter);
      return adapter;
    },
  };

  return {
    registry,
    clock,
    audit,
    pricing,
    adapters,
    adapterFactory,
    register(descriptor, actorId = 'operator-1') {
      const adapter = createFakeEngineAdapter({ engineId: descriptor.engineId });
      adapters.set(descriptor.engineId, adapter);
      registry.register({ descriptor, adapter, actorId });
      return adapter;
    },
  };
}
