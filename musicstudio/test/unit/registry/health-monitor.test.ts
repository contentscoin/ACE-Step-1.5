import { describe, expect, it } from 'vitest';

import { createHealthMonitor } from '../../../adapters/registry/health-monitor';
import {
  HEALTH_CHECK_MAX_INTERVAL_MS,
  HEALTH_CHECK_MIN_INTERVAL_MS,
  isWithinCheckTolerance,
  nextCheckDelayMs,
} from '../../../adapters/registry/health-schedule';
import { HEALTH_CHECK_TIMEOUT_MS } from '../../../adapters/timeout-runner';
import {
  createManualScheduler,
  createRegistryHarness,
  createScriptedTimeoutRunner,
  engineDescriptor,
  flushAsync,
} from '../../support/registry-harness';

/**
 * Requirement 20.7 (cadence, 10 s budget), 20.8 (three failures -> unavailable),
 * 20.21 (two successes -> available).
 *
 * Timing is asserted through an injected clock and a manual scheduler; no test
 * here waits for a real interval.
 */
describe('health monitor cadence and budget (Req 20.7)', () => {
  it('draws every delay from the 60 ± 5 s window', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = nextCheckDelayMs(() => r);
      expect(delay).toBeGreaterThanOrEqual(HEALTH_CHECK_MIN_INTERVAL_MS);
      expect(delay).toBeLessThanOrEqual(HEALTH_CHECK_MAX_INTERVAL_MS);
      expect(isWithinCheckTolerance(delay)).toBe(true);
    }

    expect(nextCheckDelayMs(() => 0)).toBe(55_000);
    expect(nextCheckDelayMs(() => 0.5)).toBe(60_000);
    expect(isWithinCheckTolerance(54_999)).toBe(false);
    expect(isWithinCheckTolerance(65_001)).toBe(false);
  });

  it('schedules the next cycle within tolerance and probes every engine', async () => {
    const harness = createRegistryHarness();
    harness.register(engineDescriptor('engine-a'));
    harness.register(engineDescriptor('engine-b'));

    const scheduler = createManualScheduler();
    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner: createScriptedTimeoutRunner(),
      scheduler,
      random: () => 0.5,
    });

    monitor.start();
    expect(scheduler.pendingDelaysMs).toEqual([60_000]);

    harness.clock.advanceSeconds(60);
    expect(scheduler.runNext()).toBe(true);
    await flushAsync();

    expect(harness.adapters.get('engine-a')?.healthCheckCount).toBe(1);
    expect(harness.adapters.get('engine-b')?.healthCheckCount).toBe(1);

    // The cycle re-arms itself, again within the 60 ± 5 s window.
    expect(scheduler.pendingDelaysMs).toEqual([60_000]);
    expect(harness.registry.require('engine-a').history.records.length).toBe(1);

    monitor.stop();
    expect(scheduler.pendingDelaysMs).toEqual([]);
  });

  it('caps each probe at 10 seconds and counts the cut-off as a failure', async () => {
    const harness = createRegistryHarness();
    const adapter = harness.register(engineDescriptor('slow-engine'));
    adapter.setDefaultHealth('hang');

    const timeoutRunner = createScriptedTimeoutRunner();
    timeoutRunner.timeOutNext();
    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner,
      scheduler: createManualScheduler(),
    });

    const outcome = await monitor.checkOnce('slow-engine');

    expect(timeoutRunner.observedBudgetsMs).toEqual([HEALTH_CHECK_TIMEOUT_MS]);
    expect(outcome.record.outcome).toBe('failure');
    expect(outcome.record.timedOut).toBe(true);
    expect(outcome.record.latencyMs).toBe(HEALTH_CHECK_TIMEOUT_MS);
  });

  it('records a thrown probe as a failure with its reason', async () => {
    const harness = createRegistryHarness();
    harness.register(engineDescriptor('throwing')).setDefaultHealth('throw');

    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner: createScriptedTimeoutRunner(),
      scheduler: createManualScheduler(),
    });

    const outcome = await monitor.checkOnce('throwing');

    expect(outcome.record.outcome).toBe('failure');
    expect(outcome.record.detail).toContain('probe failed');
  });

  it('stamps each record with the injected clock, in milliseconds', async () => {
    const harness = createRegistryHarness({ startAt: new Date('2025-03-01T00:00:00.000Z') });
    harness.register(engineDescriptor('stamped'));

    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner: createScriptedTimeoutRunner(),
      scheduler: createManualScheduler(),
    });

    const first = await monitor.checkOnce('stamped');
    harness.clock.advanceSeconds(60);
    const second = await monitor.checkOnce('stamped');

    expect(first.record.checkedAtMs).toBe(Date.parse('2025-03-01T00:00:00.000Z'));
    expect(second.record.checkedAtMs - first.record.checkedAtMs).toBe(60_000);
    expect(isWithinCheckTolerance(second.record.checkedAtMs - first.record.checkedAtMs)).toBe(true);
  });
});

describe('availability transitions (Req 20.8, 20.21)', () => {
  it('goes unavailable on the third consecutive failure, not earlier', async () => {
    const harness = createRegistryHarness();
    const adapter = harness.register(engineDescriptor('flaky'));
    adapter.enqueueHealth('unhealthy', 'unhealthy', 'unhealthy');

    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner: createScriptedTimeoutRunner(),
      scheduler: createManualScheduler(),
    });

    const first = await monitor.checkOnce('flaky');
    expect(first.transition).toBeNull();
    expect(harness.registry.require('flaky').availabilityState.availability).toBe('available');

    const second = await monitor.checkOnce('flaky');
    expect(second.transition).toBeNull();
    expect(harness.registry.require('flaky').availabilityState.availability).toBe('available');

    const third = await monitor.checkOnce('flaky');
    expect(third.transition).toBe('became_unavailable');
    expect(harness.registry.require('flaky').availabilityState.availability).toBe('unavailable');
  });

  it('resets the failure streak on any success', async () => {
    const harness = createRegistryHarness();
    harness
      .register(engineDescriptor('recovering'))
      .enqueueHealth('unhealthy', 'unhealthy', 'healthy', 'unhealthy', 'unhealthy');

    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner: createScriptedTimeoutRunner(),
      scheduler: createManualScheduler(),
    });

    for (let i = 0; i < 5; i += 1) await monitor.checkOnce('recovering');

    expect(harness.registry.require('recovering').availabilityState.availability).toBe('available');
    expect(harness.registry.require('recovering').availabilityState.consecutiveFailures).toBe(2);
  });

  it('returns to available on the second consecutive success (Req 20.21)', async () => {
    const harness = createRegistryHarness();
    harness
      .register(engineDescriptor('outage'))
      .enqueueHealth('unhealthy', 'unhealthy', 'unhealthy', 'healthy', 'healthy');

    const monitor = createHealthMonitor({
      registry: harness.registry,
      clock: harness.clock,
      timeoutRunner: createScriptedTimeoutRunner(),
      scheduler: createManualScheduler(),
    });

    await monitor.checkOnce('outage');
    await monitor.checkOnce('outage');
    await monitor.checkOnce('outage');
    const firstSuccess = await monitor.checkOnce('outage');
    expect(firstSuccess.transition).toBeNull();
    expect(harness.registry.require('outage').availabilityState.availability).toBe('unavailable');

    const secondSuccess = await monitor.checkOnce('outage');
    expect(secondSuccess.transition).toBe('became_available');
    expect(harness.registry.require('outage').availabilityState.availability).toBe('available');
  });
});
