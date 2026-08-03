import { describe, expect, it } from 'vitest';

import {
  createAdminConsole,
  meanDurationMs,
  type AdminMetricsPort,
} from '../../../services/admin/admin-console';
import { GenerationError } from '../../../services/generation/errors';
import type { AdminCaller } from '../../../services/admin/threshold-service';

/**
 * Admin_Console.
 *
 * **Validates: Requirements 18.1, 18.2, 18.9, 18.10, 18.13**
 *
 * Each clause enumerates what its query returns, so most of this is that the enumeration is
 * complete. The two cases worth more than that are the average over an empty window — which is
 * `null`, not zero — and the engine failure rate, which has to be the *same* number the alert of
 * Requirement 18.11 fires on.
 */

const OPERATOR: AdminCaller = { accountId: 'operator-1', isOperator: true };
const USER: AdminCaller = { accountId: 'user-1', isOperator: false };

const EMPTY: AdminMetricsPort = {
  async operations() {
    return {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      completedDurationTotalMs: 0,
      completedCount: 0,
      queueDepth: 0,
      queueCapacity: 100,
    };
  },
  async engines() {
    return [];
  },
  async assetKinds() {
    return [];
  },
  async jobDiagnostics() {
    return null;
  },
};

function build(overrides: Partial<AdminMetricsPort> = {}) {
  return createAdminConsole({ metrics: { ...EMPTY, ...overrides } });
}

describe('the operator gate', () => {
  it('refuses a non-operator on every query', async () => {
    const console_ = build();
    for (const call of [
      () => console_.operations(USER),
      () => console_.engines(USER),
      () => console_.assetKinds(USER),
      () => console_.job(USER, 'job-1'),
    ]) {
      await expect(call()).rejects.toThrow(GenerationError);
    }
  });
});

describe('operations summary (Reqs 18.1, 18.2)', () => {
  it('returns every count the clause enumerates', async () => {
    const summary = await build({
      async operations() {
        return {
          queued: 12,
          running: 3,
          succeeded: 480,
          failed: 20,
          completedDurationTotalMs: 500_000,
          completedCount: 500,
          queueDepth: 40,
          queueCapacity: 50,
        };
      },
    }).operations(OPERATOR);

    expect(summary).toEqual({
      queued: 12,
      running: 3,
      succeeded: 480,
      failed: 20,
      averageDurationMs: 1_000,
      queueUtilisation: 0.8,
      // Requirement 18.2 asks for the maximum *with* the utilisation: 40 of 50 and 40 of 500
      // are the same depth and different situations.
      queueCapacity: 50,
    });
  });

  it('reports no average rather than a zero one', async () => {
    const summary = await build().operations(OPERATOR);
    // "0 ms average" beside "0 jobs" reads as something being very fast.
    expect(summary.averageDurationMs).toBeNull();
    expect(meanDurationMs(0, 0)).toBeNull();
    expect(meanDurationMs(3, 2)).toBe(2);
  });
});

describe('engine status (Req 18.10)', () => {
  it('returns each engine’s four values, sorted', async () => {
    const rows = await build({
      async engines() {
        return [
          {
            engineId: 'zeta',
            pendingJobs: 4,
            window: { total: 100, failed: 25 },
            quotaRemaining: 120,
            lastHealthCheckAtMs: 1_700_000_000_000,
            lastHealthCheckHealthy: true,
          },
          {
            engineId: 'alpha',
            pendingJobs: 0,
            window: { total: 2, failed: 1 },
            quotaRemaining: 900,
            lastHealthCheckAtMs: null,
            lastHealthCheckHealthy: null,
          },
        ];
      },
    }).engines(OPERATOR);

    expect(rows.map((row) => row.engineId)).toEqual(['alpha', 'zeta']);
    expect(rows[1]).toEqual({
      engineId: 'zeta',
      pendingJobs: 4,
      failureRate15m: 0.25,
      quotaRemaining: 120,
      lastHealthCheckAtMs: 1_700_000_000_000,
      lastHealthCheckHealthy: true,
    });
    // Too few samples for a rate — the same rule the alert applies, so the dashboard and the
    // page an operator was woken by cannot disagree about whether an engine is failing.
    expect(rows[0]?.failureRate15m).toBeNull();
  });

  it('reports an engine that has never been health-checked as unknown, not unhealthy', async () => {
    const rows = await build({
      async engines() {
        return [
          {
            engineId: 'new',
            pendingJobs: 0,
            window: { total: 0, failed: 0 },
            quotaRemaining: 100,
            lastHealthCheckAtMs: null,
            lastHealthCheckHealthy: null,
          },
        ];
      },
    }).engines(OPERATOR);

    expect(rows[0]?.lastHealthCheckHealthy).toBeNull();
  });
});

describe('per-kind statistics (Req 18.13)', () => {
  it('returns the 24-hour count and average, sorted by kind', async () => {
    const rows = await build({
      async assetKinds() {
        return [
          { assetKind: 'song', createdLast24h: 40, durationTotalMs: 400_000, completedCount: 40 },
          { assetKind: 'bgm', createdLast24h: 7, durationTotalMs: 0, completedCount: 0 },
        ];
      },
    }).assetKinds(OPERATOR);

    expect(rows.map((row) => row.assetKind)).toEqual(['bgm', 'song']);
    expect(rows[1]?.averageDurationMs).toBe(10_000);
    // Seven created, none finished: a count with no average, not an average of zero.
    expect(rows[0]?.createdLast24h).toBe(7);
    expect(rows[0]?.averageDurationMs).toBeNull();
  });
});

describe('job diagnostics (Req 18.9)', () => {
  it('returns the transition history and the failure reason', async () => {
    const diagnostics = await build({
      async jobDiagnostics(jobId) {
        return jobId === 'job-1'
          ? {
              jobId,
              transitions: [
                { from: null, to: 'queued', atMs: 1 },
                { from: 'queued', to: 'running', atMs: 2 },
                { from: 'running', to: 'failed', atMs: 3 },
              ],
              failureReason: 'engine_timeout',
            }
          : null;
      },
    }).job(OPERATOR, 'job-1');

    expect(diagnostics.transitions).toHaveLength(3);
    expect(diagnostics.failureReason).toBe('engine_timeout');
  });

  it('answers 404 for a job that does not exist', async () => {
    await expect(build().job(OPERATOR, 'nope')).rejects.toThrow(/No such Generation_Job/);
  });
});
