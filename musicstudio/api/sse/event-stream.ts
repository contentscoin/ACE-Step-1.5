/**
 * Server-Sent Events transport for job progress (Requirement 5.4; design §2.3,
 * §1.4.5's `api/sse/`).
 *
 * Split into two halves on purpose:
 *
 * - `formatSseFrame` is pure text assembly, so the wire format (field order, the
 *   blank-line terminator, multi-line `data` folding) is checkable without a
 *   socket.
 * - `attachJobEventStream` is the plumbing: subscribe, write, clean up. It records
 *   the instant of every write, which is how the Requirement 5.4 one-second bound
 *   gets asserted as a comparison between `deliverByMs` and an observed write time
 *   rather than by waiting to see whether a frame turns up.
 *
 * The sink is an interface rather than a Fastify `reply.raw`, so the same code path
 * is exercised by a test collector and by a real HTTP response.
 */

import {
  isWithinDeliveryBudget,
  type JobEventBusPort,
  type JobStatusEvent,
  type Unsubscribe,
} from '../../services/generation/job-events';
import type { Clock } from '../../services/clock';

/** Headers an SSE response requires; `no-transform` stops proxies buffering. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export interface SseFrame {
  readonly event: string;
  readonly data: unknown;
  /** Becomes the SSE `id:` field, letting a client resume with `Last-Event-ID`. */
  readonly id?: string;
  readonly retryMs?: number;
}

/**
 * One SSE frame, terminated by the blank line the protocol requires.
 *
 * `data` is JSON on a single line, but the folding is still applied: a future
 * payload containing a newline would otherwise silently truncate the frame.
 */
export function formatSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.retryMs !== undefined) lines.push(`retry: ${String(frame.retryMs)}`);
  lines.push(`event: ${frame.event}`);
  for (const line of JSON.stringify(frame.data).split('\n')) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** Requirement 5.4 payload: the state change, as the client sees it. */
export function jobEventFrame(event: JobStatusEvent): SseFrame {
  return {
    id: `${event.jobId}:${String(event.sequence)}`,
    event: 'job-status',
    data: {
      jobId: event.jobId,
      state: event.state,
      progressPercent: event.progressPercent,
      queuePosition: event.queuePosition,
      estimatedCompletionAtMs: event.estimatedCompletionAtMs,
      failure: event.failure,
      assetIds: event.assetIds,
      sequence: event.sequence,
      emittedAtMs: event.emittedAtMs,
      deliverByMs: event.deliverByMs,
    },
  };
}

export interface SseSink {
  write(chunk: string): void;
  end?(): void;
}

export interface DeliveryRecord {
  readonly jobId: string;
  readonly sequence: number;
  readonly emittedAtMs: number;
  readonly writtenAtMs: number;
  /** Requirement 5.4: was the frame written inside the one-second budget? */
  readonly withinBudget: boolean;
}

export interface JobEventStreamOptions {
  readonly bus: JobEventBusPort;
  readonly accountId: string;
  /** Restrict to one job; omitted streams every job of the account. */
  readonly jobId?: string;
  readonly clock: Clock;
  readonly sink: SseSink;
}

export interface JobEventStream {
  close(): void;
  /** Delivery instants, in write order. The Requirement 5.4 evidence. */
  readonly deliveries: readonly DeliveryRecord[];
}

export function attachJobEventStream(options: JobEventStreamOptions): JobEventStream {
  const deliveries: DeliveryRecord[] = [];

  const unsubscribe: Unsubscribe = options.bus.subscribe(options.accountId, (event) => {
    if (options.jobId !== undefined && event.jobId !== options.jobId) return;

    options.sink.write(formatSseFrame(jobEventFrame(event)));
    const writtenAtMs = options.clock.now().getTime();

    deliveries.push({
      jobId: event.jobId,
      sequence: event.sequence,
      emittedAtMs: event.emittedAtMs,
      writtenAtMs,
      withinBudget: isWithinDeliveryBudget(event, writtenAtMs),
    });
  });

  return {
    deliveries,
    close: () => {
      unsubscribe();
      options.sink.end?.();
    },
  };
}
