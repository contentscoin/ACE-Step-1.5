import { describe, expect, it } from 'vitest';

import {
  ENGINE_LATENCY_ALERT_MS,
  FAILURE_RATE_ALERT_RATIO,
  MIN_SAMPLES_FOR_RATE_ALERT,
  QUEUE_UTILISATION_ALERT_RATIO,
  QUOTA_REMAINING_ALERT_RATIO,
  THRESHOLD_FAILURE_RATE_ALERT_RATIO,
  evaluateAlerts,
  failureRate,
  queueUtilisation,
  type EngineSnapshot,
  type MetricsSnapshot,
} from '../../../domain/observability/alerts';

/**
 * The six alert conditions, at their boundaries.
 *
 * **Validates: Requirements 18.3, 18.4, 18.11, 18.12, 18.14, 34.8**
 *
 * ### Why every case is a boundary case
 *
 * Three of the six clauses are strict (초과) and two are inclusive (이상 / 이하). An
 * implementation that used one comparison throughout passes every test that samples the middle
 * of the range and is wrong at exactly the value an operator configures. So each condition is
 * checked one step below, exactly at, and one step above its threshold.
 */

const QUIET: MetricsSnapshot = {
  queue: { queueDepth: 0, queueCapacity: 100 },
  overallWindow: { total: 100, failed: 0 },
  engines: [],
  thresholds: [],
};

function engine(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    engineId: 'ace-step-1.5',
    window: { total: 100, failed: 0 },
    dailyQuota: 1_000,
    quotaRemaining: 1_000,
    meanLatencyMs: null,
    ...overrides,
  };
}

function kinds(snapshot: MetricsSnapshot): readonly string[] {
  return evaluateAlerts(snapshot).map((alert) => alert.kind);
}

describe('queue utilisation (Req 18.3 — 80% 이상)', () => {
  it('is quiet just below, and fires exactly at 80%', () => {
    expect(kinds({ ...QUIET, queue: { queueDepth: 79, queueCapacity: 100 } })).toEqual([]);
    // Inclusive: the clause says 이상, so the boundary itself fires.
    expect(kinds({ ...QUIET, queue: { queueDepth: 80, queueCapacity: 100 } })).toEqual([
      'queue_utilisation',
    ]);
    expect(kinds({ ...QUIET, queue: { queueDepth: 81, queueCapacity: 100 } })).toEqual([
      'queue_utilisation',
    ]);
  });

  it('reports the observed value and the threshold it beat', () => {
    const alert = evaluateAlerts({ ...QUIET, queue: { queueDepth: 90, queueCapacity: 100 } })[0];
    expect(alert?.observed).toBeCloseTo(0.9);
    expect(alert?.threshold).toBe(QUEUE_UTILISATION_ALERT_RATIO);
    expect(alert?.message).toContain('90.0%');
  });

  it('treats a zero capacity as a misconfiguration, not a full queue', () => {
    // 100% would page an operator about saturation when nothing is configured.
    expect(queueUtilisation({ queueDepth: 5, queueCapacity: 0 })).toBe(0);
    expect(kinds({ ...QUIET, queue: { queueDepth: 5, queueCapacity: 0 } })).toEqual([]);
  });
});

describe('failure rate (Reqs 18.4, 18.11 — 10% 초과)', () => {
  it('is quiet exactly at 10% and fires above it', () => {
    // Strict: the clause says 초과, so the boundary itself does not fire.
    expect(kinds({ ...QUIET, overallWindow: { total: 100, failed: 10 } })).toEqual([]);
    expect(kinds({ ...QUIET, overallWindow: { total: 100, failed: 11 } })).toEqual([
      'failure_rate',
    ]);
  });

  it('says nothing about a window with too few samples', () => {
    // One failure out of one job is 100%. Alerting on that is how an operator learns to
    // ignore the channel on a quiet night.
    expect(failureRate({ total: 1, failed: 1 })).toBeNull();
    expect(kinds({ ...QUIET, overallWindow: { total: 1, failed: 1 } })).toEqual([]);
    expect(
      kinds({
        ...QUIET,
        overallWindow: { total: MIN_SAMPLES_FOR_RATE_ALERT, failed: MIN_SAMPLES_FOR_RATE_ALERT },
      }),
    ).toEqual(['failure_rate']);
  });

  it('names the engine in a per-engine alert (Req 18.11)', () => {
    const alerts = evaluateAlerts({
      ...QUIET,
      engines: [engine({ engineId: 'woosh', window: { total: 100, failed: 50 } })],
    });
    expect(alerts.map((alert) => alert.kind)).toEqual(['engine_failure_rate']);
    expect(alerts[0]?.subject).toBe('woosh');
    expect(alerts[0]?.message).toContain('woosh');
  });

  it('reports every engine in trouble, not the first', () => {
    const alerts = evaluateAlerts({
      ...QUIET,
      engines: [
        engine({ engineId: 'zeta', window: { total: 100, failed: 40 } }),
        engine({ engineId: 'alpha', window: { total: 100, failed: 40 } }),
      ],
    });
    // Sorted, so two evaluations of the same state read the same.
    expect(alerts.map((alert) => alert.subject)).toEqual(['alpha', 'zeta']);
  });
});

describe('quota remaining (Req 18.12 — 배정량의 10% 이하)', () => {
  it('is quiet just above, and fires exactly at 10%', () => {
    expect(kinds({ ...QUIET, engines: [engine({ quotaRemaining: 101 })] })).toEqual([]);
    // Inclusive: 이하.
    expect(kinds({ ...QUIET, engines: [engine({ quotaRemaining: 100 })] })).toEqual([
      'engine_quota_low',
    ]);
    expect(kinds({ ...QUIET, engines: [engine({ quotaRemaining: 0 })] })).toEqual([
      'engine_quota_low',
    ]);
  });

  it('treats an unlimited engine as having quota', () => {
    expect(kinds({ ...QUIET, engines: [engine({ dailyQuota: 0, quotaRemaining: 0 })] })).toEqual(
      [],
    );
  });

  it('states the ratio it measured', () => {
    const alert = evaluateAlerts({
      ...QUIET,
      engines: [engine({ quotaRemaining: 50 })],
    })[0];
    expect(alert?.observed).toBeCloseTo(0.05);
    expect(alert?.threshold).toBe(QUOTA_REMAINING_ALERT_RATIO);
  });
});

describe('engine latency (Req 18.14 — 60초 초과)', () => {
  it('is quiet exactly at 60 s and fires above it', () => {
    expect(kinds({ ...QUIET, engines: [engine({ meanLatencyMs: 60_000 })] })).toEqual([]);
    expect(kinds({ ...QUIET, engines: [engine({ meanLatencyMs: 60_001 })] })).toEqual([
      'engine_latency',
    ]);
    expect(ENGINE_LATENCY_ALERT_MS).toBe(60_000);
  });

  it('says nothing about a local engine with no latency to report', () => {
    expect(kinds({ ...QUIET, engines: [engine({ meanLatencyMs: null })] })).toEqual([]);
  });
});

describe('quality threshold failure rate (Req 34.8 — 7일 20% 초과)', () => {
  it('is quiet exactly at 20% and fires above it', () => {
    expect(
      kinds({
        ...QUIET,
        thresholds: [{ thresholdName: 'lufs_floor', window: { total: 100, failed: 20 } }],
      }),
    ).toEqual([]);
    expect(
      kinds({
        ...QUIET,
        thresholds: [{ thresholdName: 'lufs_floor', window: { total: 100, failed: 21 } }],
      }),
    ).toEqual(['quality_threshold_failure_rate']);
  });

  it('names the threshold and the rate, which is what the clause asks for', () => {
    const alert = evaluateAlerts({
      ...QUIET,
      thresholds: [{ thresholdName: 'true_peak_ceiling', window: { total: 100, failed: 35 } }],
    })[0];
    expect(alert?.subject).toBe('true_peak_ceiling');
    expect(alert?.message).toContain('true_peak_ceiling');
    expect(alert?.message).toContain('35.0%');
    expect(alert?.threshold).toBe(THRESHOLD_FAILURE_RATE_ALERT_RATIO);
  });
});

describe('several conditions at once', () => {
  it('reports all of them', () => {
    const alerts = evaluateAlerts({
      queue: { queueDepth: 95, queueCapacity: 100 },
      overallWindow: { total: 100, failed: 30 },
      engines: [
        engine({
          engineId: 'woosh',
          window: { total: 100, failed: 40 },
          quotaRemaining: 10,
          meanLatencyMs: 90_000,
        }),
      ],
      thresholds: [{ thresholdName: 'lufs_floor', window: { total: 100, failed: 50 } }],
    });

    // An evaluator that stopped at the first would hide the rest until it was fixed.
    expect(alerts.map((alert) => alert.kind)).toEqual([
      'queue_utilisation',
      'failure_rate',
      'engine_failure_rate',
      'engine_quota_low',
      'engine_latency',
      'quality_threshold_failure_rate',
    ]);
    expect(FAILURE_RATE_ALERT_RATIO).toBe(0.1);
  });
});
