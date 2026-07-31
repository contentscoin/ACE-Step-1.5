/**
 * Status change notifications (Requirement 5.4; design §2.3).
 *
 * 5.4 requires a state change to reach the owner's open client connections within
 * one second. A test that *waits* to see whether that happened would either be
 * slow or flaky, so the bound is carried on the event itself: every event states
 * the instant it was emitted and the instant by which it must be delivered. The
 * SSE layer records when it wrote each frame, and the assertion compares two
 * numbers.
 *
 * The bus is in-process and synchronous. That is not a simplification of the
 * production shape but the reason the bound holds: the orchestrator publishes
 * inside the same transition that changed the state, so there is no queue between
 * the change and the write to the socket. A cross-process fan-out (Redis pub/sub
 * across gateway pods) would be a second implementation of this port, and
 * `deliverByMs` is what such an implementation would have to be measured against.
 */

import type { JobFailure } from '../../domain/generation-job/failure';
import type { GenerationJobState } from '../../domain/generation-job/lifecycle';

/** Requirement 5.4. */
export const SSE_DELIVERY_BUDGET_MS = 1_000;

export interface JobStatusEvent {
  readonly jobId: string;
  readonly accountId: string;
  /** Requirement 5.3: the user-facing state, never an engine status code. */
  readonly state: GenerationJobState;
  readonly progressPercent: number | null;
  /** Requirement 5.1/5.5: 1-based, `null` once the job is no longer waiting. */
  readonly queuePosition: number | null;
  /** Requirement 5.5. */
  readonly estimatedCompletionAtMs: number | null;
  /** Requirement 6.1: classification and retryability travel with the failure. */
  readonly failure: JobFailure | null;
  /** Requirement 5.6: assets created from the results. */
  readonly assetIds: readonly string[];
  readonly emittedAtMs: number;
  /** Requirement 5.4: `emittedAtMs + SSE_DELIVERY_BUDGET_MS`. */
  readonly deliverByMs: number;
  /** Per-job counter, so a client can detect a gap or a reorder. */
  readonly sequence: number;
}

export type JobEventListener = (event: JobStatusEvent) => void;

/** Unsubscribes; safe to call more than once. */
export type Unsubscribe = () => void;

export interface JobEventBusPort {
  publish(event: JobStatusEvent): void;
  /** Subscribes to one account's events — the "open client connection" of 5.4. */
  subscribe(accountId: string, listener: JobEventListener): Unsubscribe;
}

export function createInMemoryJobEventBus(): JobEventBusPort {
  const listeners = new Map<string, Set<JobEventListener>>();

  return {
    publish(event) {
      // A copy, so a listener that unsubscribes mid-fan-out cannot skip a peer.
      for (const listener of [...(listeners.get(event.accountId) ?? [])]) {
        listener(event);
      }
    },
    subscribe(accountId, listener) {
      const existing = listeners.get(accountId) ?? new Set<JobEventListener>();
      existing.add(listener);
      listeners.set(accountId, existing);

      return () => {
        const current = listeners.get(accountId);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(accountId);
      };
    },
  };
}

/** Requirement 5.4 predicate: was the event delivered inside its budget? */
export function isWithinDeliveryBudget(event: JobStatusEvent, deliveredAtMs: number): boolean {
  return deliveredAtMs <= event.deliverByMs;
}

export function deliveryDeadlineMs(emittedAtMs: number): number {
  return emittedAtMs + SSE_DELIVERY_BUDGET_MS;
}
