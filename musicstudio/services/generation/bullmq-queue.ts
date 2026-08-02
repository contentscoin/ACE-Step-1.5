/**
 * BullMQ translation of `JobQueuePort` (design §2.4, §11.3).
 *
 * Kept deliberately thin: it maps four port methods onto four BullMQ calls and
 * carries no rule of its own. Every Requirement 5 and 6 behaviour is decided in
 * `domain/generation-job/` and driven by `job-orchestrator.ts`, both of which run
 * against the in-memory queue, so nothing about the acceptance criteria depends on
 * a Redis being reachable.
 *
 * The BullMQ `Queue` arrives as an injected handle typed by the structural subset
 * used here, rather than through `import { Queue } from 'bullmq'`. Two reasons:
 *
 * - Redis is unavailable in this environment, so a compile-time dependency would
 *   buy a package that no test could exercise.
 * - The retry configuration is the part worth pinning, and `bullMqJobOptions()`
 *   pins it as a value derived from `domain/generation-job/retry-policy.ts`. The
 *   Requirement 6.2 numbers are asserted once, in the domain, and this adapter is
 *   checked against the same source rather than restating them.
 *
 * Production wiring (`new Queue(name, { connection })` passed as `handle`) belongs
 * to the service bootstrap and is not part of this task.
 */

import {
  MAX_ENGINE_RETRY_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
} from '../../domain/generation-job/retry-policy';

import type { JobQueuePort, QueuePlacement } from './job-queue';

/** The subset of BullMQ's `Queue` this adapter calls. */
export interface BullQueueHandle {
  add(name: string, data: unknown, options?: BullJobOptions): Promise<{ readonly id?: string | null }>;
  getWaitingCount(): Promise<number>;
  getWaiting(start?: number, end?: number): Promise<readonly { readonly id?: string | null }[]>;
  remove(jobId: string): Promise<number>;
}

export interface BullJobOptions {
  readonly jobId?: string;
  readonly attempts?: number;
  readonly backoff?: { readonly type: 'exponential' | 'fixed'; readonly delay: number };
  readonly removeOnComplete?: boolean;
}

export const GENERATION_JOB_QUEUE_NAME = 'generation-job';

/**
 * Requirement 6.2 expressed in BullMQ's vocabulary.
 *
 * `attempts` counts the original try plus the re-requests, so it is
 * `MAX_ENGINE_RETRY_ATTEMPTS + 1`; `delay` is the 2-second floor, which BullMQ's
 * exponential strategy then doubles — the same `[2000, 4000, 8000]` schedule
 * `retryScheduleMs()` states.
 */
export function bullMqJobOptions(jobId: string): BullJobOptions {
  return {
    jobId,
    attempts: MAX_ENGINE_RETRY_ATTEMPTS + 1,
    backoff: { type: 'exponential', delay: MIN_RETRY_DELAY_MS },
    removeOnComplete: false,
  };
}

export function createBullMqJobQueue(handle: BullQueueHandle): JobQueuePort {
  return {
    async enqueue(jobId): Promise<QueuePlacement> {
      await handle.add(GENERATION_JOB_QUEUE_NAME, { jobId }, bullMqJobOptions(jobId));
      const position = await positionIn(handle, jobId);
      // A job accepted by BullMQ but already picked up by a worker is no longer
      // waiting; reporting the tail rather than `null` keeps the Requirement 5.1
      // response a position instead of an absence.
      return { jobId, position: position ?? (await handle.getWaitingCount()) + 1 };
    },

    positionOf: async (jobId) => positionIn(handle, jobId),

    depth: () => handle.getWaitingCount(),

    async remove(jobId) {
      return (await handle.remove(jobId)) > 0;
    },
  };
}

async function positionIn(handle: BullQueueHandle, jobId: string): Promise<number | null> {
  const waiting = await handle.getWaiting();
  const index = waiting.findIndex((job) => job.id === jobId);
  return index === -1 ? null : index + 1;
}
