/**
 * Structured logging and operator alerts (Requirements 18.3, 18.4, 18.5, 18.8, 18.11, 18.12,
 * 18.14, 34.8).
 *
 * ### Alerts are re-sent on a change of state, not on every poll
 *
 * A queue that sits at 85% for an hour satisfies Requirement 18.3 for the whole hour. Sending on
 * every evaluation would put sixty identical messages in front of an operator, and the reliable
 * consequence of that is a filter rule. So an alert fires when the condition *becomes* true, and
 * again only after it has cleared — `alertKey` deliberately excludes the observed value, so 81%
 * and 84% are the same ongoing problem rather than two.
 *
 * The re-notify interval exists for the other failure: a condition that stays true for a day
 * should not be silent for a day. It is a stated constant, not a guess buried in a comparison.
 *
 * ### The emitter checks the record it was handed
 *
 * `buildJobLog` masks. `emitJobLog` checks anyway, because the builder is not the only way a
 * record can exist — a deserialised one, a literal in a future call site. Requirement 18.8 is a
 * property of what is *written*, so the check is at the write.
 *
 * A record that fails the check is **dropped and counted**, not written unmasked and not thrown
 * on: throwing at a logging call site is what pushes a caller into `console.log(user)` instead.
 */

import {
  alertKey,
  evaluateAlerts,
  type Alert,
  type MetricsSnapshot,
} from '../../domain/observability/alerts';
import {
  buildJobLog,
  isEmittableJobLog,
  type JobLogInput,
  type JobLogRecord,
} from '../../domain/observability/job-log';
import type { Clock } from '../clock';
import type { AlertSink, JobLogSink, MetricsPort } from './ports';

/**
 * How long a still-true condition stays quiet before it is repeated.
 *
 * Not from the requirements. Thirty minutes is long enough that an incident does not spam and
 * short enough that a condition surviving a shift change is seen by the next person.
 */
export const ALERT_RENOTIFY_MS = 30 * 60 * 1_000;

export interface ObservabilityServiceOptions {
  readonly metrics: MetricsPort;
  readonly alerts: AlertSink;
  readonly logs: JobLogSink;
  readonly clock: Clock;
  readonly renotifyAfterMs?: number;
}

export interface EvaluationOutcome {
  readonly firing: readonly Alert[];
  /** The subset actually sent this round — new conditions, plus any due for a repeat. */
  readonly sent: readonly Alert[];
  /** Conditions that were firing and no longer are. */
  readonly cleared: readonly string[];
}

export function createObservabilityService(options: ObservabilityServiceOptions) {
  const { metrics, alerts, logs, clock } = options;
  const renotifyAfterMs = options.renotifyAfterMs ?? ALERT_RENOTIFY_MS;

  /** Key → when it was last sent. Presence means the condition is currently firing. */
  const active = new Map<string, number>();
  let droppedUnmaskedLogs = 0;

  return {
    /** Requirement 18.5: one line per job, with design §11.2's fields. */
    logJob(input: JobLogInput): JobLogRecord | null {
      const record = buildJobLog(input);
      if (!isEmittableJobLog(record)) {
        // Requirement 18.8. Dropped rather than written or thrown — see the module header.
        droppedUnmaskedLogs += 1;
        return null;
      }
      logs.emit(record);
      return record;
    },

    /** How many records the masking gate refused. Non-zero means a call site to find. */
    droppedUnmaskedLogCount(): number {
      return droppedUnmaskedLogs;
    },

    /**
     * Evaluate every condition against one snapshot and notify what changed.
     *
     * Requirements 18.3, 18.4, 18.11, 18.12, 18.14, 34.8.
     */
    async evaluate(): Promise<EvaluationOutcome> {
      const snapshot: MetricsSnapshot = await metrics.snapshot();
      const firing = evaluateAlerts(snapshot);
      const nowMs = clock.now().getTime();

      const firingKeys = new Set(firing.map(alertKey));
      const sent: Alert[] = [];

      for (const alert of firing) {
        const key = alertKey(alert);
        const lastSentAtMs = active.get(key);
        const isNew = lastSentAtMs === undefined;
        const isDue = lastSentAtMs !== undefined && nowMs - lastSentAtMs >= renotifyAfterMs;
        if (!isNew && !isDue) continue;

        await alerts.send(alert);
        active.set(key, nowMs);
        sent.push(alert);
      }

      const cleared: string[] = [];
      for (const key of [...active.keys()]) {
        if (!firingKeys.has(key)) {
          active.delete(key);
          cleared.push(key);
        }
      }

      return { firing, sent, cleared: cleared.sort() };
    },

    /** The conditions currently believed to be firing, for a dashboard or a test. */
    activeAlertKeys(): readonly string[] {
      return [...active.keys()].sort();
    },
  };
}

export type ObservabilityService = ReturnType<typeof createObservabilityService>;
