/**
 * The six alert conditions (Requirements 18.3, 18.4, 18.11, 18.12, 18.14, 34.8).
 *
 * | condition | threshold | window | clause |
 * |---|---|---|---|
 * | ACE_Engine queue utilisation | **≥** 80% | now | 18.3 |
 * | overall job failure rate | **>** 10% | 15 min | 18.4 |
 * | per-engine failure rate | **>** 10% | 15 min | 18.11 |
 * | engine daily quota remaining | **≤** 10% | today | 18.12 |
 * | remote engine mean latency | **>** 60 s | 15 min | 18.14 |
 * | threshold-attributed failure rate | **>** 20% | 7 days | 34.8 |
 *
 * ### The comparisons are not all the same, and that is the requirement's doing
 *
 * Three of the six are strict (`>`) and two are inclusive (`≥` / `≤`), because the clauses are:
 * 18.3 says 80% **이상**, 18.12 says 10% **이하**, and 18.4/18.11/18.14/34.8 all say **초과**.
 * A tidy implementation that used one operator throughout would be wrong at exactly the boundary
 * — the value an operator sets the threshold to, and the value a test is most likely to try.
 * `test/unit/observability/alerts.test.ts` checks every boundary from both sides.
 *
 * ### A rate over no samples is not zero
 *
 * A 15-minute window with no jobs in it has an *undefined* failure rate, not a 0% one. Returning
 * 0 would be harmless; the danger is the other reading — one failure out of one job is 100%, and
 * firing a "failure rate exceeded" alert for a single failed job on a quiet Sunday is how an
 * operator learns to ignore the channel. So a minimum sample count gates the rate alerts, and it
 * is a stated constant rather than an accident of the data.
 */

/** Requirement 18.3. Inclusive: 80% 이상. */
export const QUEUE_UTILISATION_ALERT_RATIO = 0.8;

/** Requirements 18.4, 18.11. Strict: 10% 초과. */
export const FAILURE_RATE_ALERT_RATIO = 0.1;
export const FAILURE_RATE_WINDOW_MS = 15 * 60 * 1_000;

/** Requirement 18.12. Inclusive: 배정량의 10% 이하. */
export const QUOTA_REMAINING_ALERT_RATIO = 0.1;

/** Requirement 18.14. Strict: 60초 초과. */
export const ENGINE_LATENCY_ALERT_MS = 60_000;

/** Requirement 34.8. Strict: 20% 초과, over seven days. */
export const THRESHOLD_FAILURE_RATE_ALERT_RATIO = 0.2;
export const THRESHOLD_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * How many jobs a window needs before its failure rate is worth alerting on.
 *
 * Not from the requirements — they say nothing about it — so it is a product decision, recorded
 * here with its reason. Ten is enough that a single failure cannot trip a 10% threshold, which
 * is the case that would otherwise page someone every quiet night.
 */
export const MIN_SAMPLES_FOR_RATE_ALERT = 10;

export const ALERT_KINDS = [
  'queue_utilisation',
  'failure_rate',
  'engine_failure_rate',
  'engine_quota_low',
  'engine_latency',
  'quality_threshold_failure_rate',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  readonly kind: AlertKind;
  /** The engine or threshold the alert is about; `null` for the whole-system ones. */
  readonly subject: string | null;
  /** What was measured, and what it had to beat. Both in the alert so it explains itself. */
  readonly observed: number;
  readonly threshold: number;
  readonly message: string;
}

/* --------------------------------------------------------------- inputs */

export interface QueueSnapshot {
  readonly queueDepth: number;
  readonly queueCapacity: number;
}

export interface FailureWindow {
  readonly total: number;
  readonly failed: number;
}

export interface EngineSnapshot {
  readonly engineId: string;
  readonly window: FailureWindow;
  readonly dailyQuota: number;
  readonly quotaRemaining: number;
  /** Mean over the same 15 minutes; `null` for a local engine with nothing to measure. */
  readonly meanLatencyMs: number | null;
}

export interface ThresholdSnapshot {
  readonly thresholdName: string;
  readonly window: FailureWindow;
}

export interface MetricsSnapshot {
  readonly queue: QueueSnapshot;
  readonly overallWindow: FailureWindow;
  readonly engines: readonly EngineSnapshot[];
  readonly thresholds: readonly ThresholdSnapshot[];
}

/* ---------------------------------------------------------------- rules */

/** `null` when the window has too few samples to have a meaningful rate — see the header. */
export function failureRate(window: FailureWindow): number | null {
  if (window.total < MIN_SAMPLES_FOR_RATE_ALERT) return null;
  if (window.total <= 0) return null;
  return window.failed / window.total;
}

export function queueUtilisation(queue: QueueSnapshot): number {
  // A zero capacity is a misconfiguration, not a full queue. Reporting 100% would page an
  // operator about saturation when the real problem is that nothing is configured.
  if (queue.queueCapacity <= 0) return 0;
  return queue.queueDepth / queue.queueCapacity;
}

export function quotaRemainingRatio(engine: EngineSnapshot): number {
  if (engine.dailyQuota <= 0) return 1;
  return engine.quotaRemaining / engine.dailyQuota;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Every condition that holds, in a stable order.
 *
 * All of them, not the first: two engines can be in trouble at once, and an evaluator that
 * returned one would hide the second until the first was fixed.
 */
export function evaluateAlerts(snapshot: MetricsSnapshot): readonly Alert[] {
  const alerts: Alert[] = [];

  // Requirement 18.3 — inclusive.
  const utilisation = queueUtilisation(snapshot.queue);
  if (utilisation >= QUEUE_UTILISATION_ALERT_RATIO) {
    alerts.push({
      kind: 'queue_utilisation',
      subject: null,
      observed: utilisation,
      threshold: QUEUE_UTILISATION_ALERT_RATIO,
      message: `ACE_Engine 큐 사용률 ${percent(utilisation)} (임계 ${percent(QUEUE_UTILISATION_ALERT_RATIO)} 이상)`,
    });
  }

  // Requirement 18.4 — strict.
  const overall = failureRate(snapshot.overallWindow);
  if (overall !== null && overall > FAILURE_RATE_ALERT_RATIO) {
    alerts.push({
      kind: 'failure_rate',
      subject: null,
      observed: overall,
      threshold: FAILURE_RATE_ALERT_RATIO,
      message: `최근 15분 생성 실패율 ${percent(overall)} (임계 ${percent(FAILURE_RATE_ALERT_RATIO)} 초과)`,
    });
  }

  for (const engine of [...snapshot.engines].sort((a, b) => a.engineId.localeCompare(b.engineId))) {
    // Requirement 18.11 — strict, and the alert carries the engine identifier.
    const rate = failureRate(engine.window);
    if (rate !== null && rate > FAILURE_RATE_ALERT_RATIO) {
      alerts.push({
        kind: 'engine_failure_rate',
        subject: engine.engineId,
        observed: rate,
        threshold: FAILURE_RATE_ALERT_RATIO,
        message: `엔진 ${engine.engineId} 최근 15분 실패율 ${percent(rate)} (임계 ${percent(FAILURE_RATE_ALERT_RATIO)} 초과)`,
      });
    }

    // Requirement 18.12 — inclusive.
    const remaining = quotaRemainingRatio(engine);
    if (remaining <= QUOTA_REMAINING_ALERT_RATIO) {
      alerts.push({
        kind: 'engine_quota_low',
        subject: engine.engineId,
        observed: remaining,
        threshold: QUOTA_REMAINING_ALERT_RATIO,
        message: `엔진 ${engine.engineId} 일일 쿼터 잔량 ${percent(remaining)} (임계 ${percent(QUOTA_REMAINING_ALERT_RATIO)} 이하)`,
      });
    }

    // Requirement 18.14 — strict, remote engines only (a local one reports `null`).
    if (engine.meanLatencyMs !== null && engine.meanLatencyMs > ENGINE_LATENCY_ALERT_MS) {
      alerts.push({
        kind: 'engine_latency',
        subject: engine.engineId,
        observed: engine.meanLatencyMs,
        threshold: ENGINE_LATENCY_ALERT_MS,
        message: `엔진 ${engine.engineId} 최근 15분 평균 응답 ${(engine.meanLatencyMs / 1000).toFixed(1)}초 (임계 60초 초과)`,
      });
    }
  }

  // Requirement 34.8 — strict, over seven days, and the alert names the threshold.
  for (const threshold of [...snapshot.thresholds].sort((a, b) =>
    a.thresholdName.localeCompare(b.thresholdName),
  )) {
    const rate = failureRate(threshold.window);
    if (rate !== null && rate > THRESHOLD_FAILURE_RATE_ALERT_RATIO) {
      alerts.push({
        kind: 'quality_threshold_failure_rate',
        subject: threshold.thresholdName,
        observed: rate,
        threshold: THRESHOLD_FAILURE_RATE_ALERT_RATIO,
        message: `임계값 ${threshold.thresholdName} 기인 최근 7일 실패율 ${percent(rate)} (임계 20% 초과) — 보정 검토 필요`,
      });
    }
  }

  return alerts;
}

/**
 * A stable identity for an alert, so a repeat of the same condition is recognised as one.
 *
 * The *observed value* is deliberately not part of it: a queue at 81% and the same queue at 84%
 * are the same ongoing problem, and including the number would re-notify on every poll.
 */
export function alertKey(alert: Alert): string {
  // U+0000 as the separator, written as an escape rather than typed: no alert kind or
  // subject contains it, so `engine_failure_rate` + `alpha-beta` and `engine_failure_rate-alpha`
  // + `beta` cannot collide into one key the way a hyphen or a space would.
  return `${alert.kind}\u0000${alert.subject ?? ''}`;
}
