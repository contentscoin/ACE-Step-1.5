/**
 * The seams the observability layer reads and writes through.
 *
 * `MetricsPort` is one call returning one snapshot rather than six queries, because the six
 * alert conditions are evaluated **together** and against the same moment. Six independent reads
 * would let a queue measured at 10:00:00 be compared with a failure window ending 10:00:03, and
 * an operator reading the resulting alerts would be looking at a state the system was never in.
 */

import type { JobLogRecord } from '../../domain/observability/job-log';
import type { Alert, MetricsSnapshot } from '../../domain/observability/alerts';

export interface MetricsPort {
  /** One snapshot, one moment. See the module header. */
  snapshot(): Promise<MetricsSnapshot>;
}

/**
 * Where a structured log line goes.
 *
 * Takes the already-built record rather than a message and a bag: the record type is closed
 * (`domain/observability/job-log.ts`), and a sink accepting `unknown` extras would be the hole
 * Requirement 18.8 is about.
 */
export interface JobLogSink {
  emit(record: JobLogRecord): void;
}

/** Where an operator alert goes — email, pager, a channel. */
export interface AlertSink {
  send(alert: Alert): Promise<void>;
}
