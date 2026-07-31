/**
 * Health-check loop (Requirements 20.7, 20.8, 20.21).
 *
 * Responsibilities are split deliberately: the cadence lives in
 * `health-schedule.ts`, the 10-second budget in `adapters/timeout-runner.ts`,
 * the state machine in `health-transitions.ts`, and retention in
 * `health-history.ts`. This module only sequences them.
 *
 * `checkOnce` / `checkAll` are public so tests drive probes directly instead of
 * waiting for a timer; `start` wires the same call into the injected scheduler
 * for production.
 */

import { HEALTH_CHECK_TIMEOUT_MS, realTimeoutRunner, type TimeoutRunner } from '../timeout-runner';
import type { HealthCheckResult } from '../engine-job';
import { systemClock, type Clock } from '../../services/clock';

import type { HealthCheckRecord } from './health-history';
import { nextCheckDelayMs, realScheduler, type Scheduler, type ScheduledTask } from './health-schedule';
import type { HealthOutcomeRecorded, ProviderRegistry } from './provider-registry';

export interface HealthMonitorOptions {
  readonly registry: ProviderRegistry;
  readonly clock?: Clock;
  readonly timeoutRunner?: TimeoutRunner;
  readonly scheduler?: Scheduler;
  /** Jitter source for the 60 ± 5 s cadence; injected so tests can pin it. */
  readonly random?: () => number;
}

export interface HealthMonitor {
  /** Probes one engine and folds the outcome into the registry. */
  checkOnce(engineId: string): Promise<HealthOutcomeRecorded>;
  /** Probes every registered engine once. */
  checkAll(): Promise<readonly HealthOutcomeRecorded[]>;
  /** Begins the 60 ± 5 s loop. Idempotent. */
  start(): void;
  stop(): void;
}

export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {
  const registry = options.registry;
  const clock = options.clock ?? systemClock;
  const timeoutRunner = options.timeoutRunner ?? realTimeoutRunner;
  const scheduler = options.scheduler ?? realScheduler;
  const random = options.random ?? Math.random;

  let pending: ScheduledTask | null = null;
  let running = false;

  const checkOnce = async (engineId: string): Promise<HealthOutcomeRecorded> => {
    const record = registry.require(engineId);
    const startedAtMs = clock.now().getTime();

    // Requirement 20.7: each probe is capped at 10 seconds. The cap is applied
    // here, not inside the adapter, so no adapter can opt out of it.
    const outcome = await timeoutRunner.run<HealthCheckResult>(
      () => record.adapter.healthCheck(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    return registry.recordHealthOutcome(engineId, toRecord(outcome, startedAtMs, clock));
  };

  const checkAll = async (): Promise<readonly HealthOutcomeRecorded[]> => {
    const results: HealthOutcomeRecorded[] = [];
    for (const engineId of registry.engineIds) {
      results.push(await checkOnce(engineId));
    }
    return results;
  };

  const scheduleNext = (): void => {
    if (!running) return;
    pending = scheduler.after(nextCheckDelayMs(random), () => {
      void checkAll().finally(scheduleNext);
    });
  };

  return {
    checkOnce,
    checkAll,
    start() {
      if (running) return;
      running = true;
      scheduleNext();
    },
    stop() {
      running = false;
      pending?.cancel();
      pending = null;
    },
  };
}

function toRecord(
  outcome: Awaited<ReturnType<TimeoutRunner['run']>>,
  startedAtMs: number,
  clock: Clock,
): HealthCheckRecord {
  const checkedAtMs = clock.now().getTime();
  const elapsedMs = Math.max(0, checkedAtMs - startedAtMs);

  if (outcome.kind === 'timed_out') {
    return {
      checkedAtMs,
      outcome: 'failure',
      latencyMs: outcome.budgetMs,
      timedOut: true,
      detail: `health check exceeded ${String(outcome.budgetMs)}ms`,
    };
  }

  if (outcome.kind === 'failed') {
    return {
      checkedAtMs,
      outcome: 'failure',
      latencyMs: elapsedMs,
      detail: describeError(outcome.error),
    };
  }

  const result = outcome.value as HealthCheckResult;
  return {
    checkedAtMs,
    outcome: result.healthy ? 'success' : 'failure',
    latencyMs: result.latencyMs,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
