import { describe, expect, it } from 'vitest';

import {
  MAX_ENGINE_RETRY_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
  retryScheduleMs,
} from '../../../domain/generation-job/retry-policy';
import {
  bullMqJobOptions,
  createBullMqJobQueue,
  GENERATION_JOB_QUEUE_NAME,
  type BullJobOptions,
  type BullQueueHandle,
} from '../../../services/generation/bullmq-queue';

/**
 * The BullMQ adapter (design §2.4).
 *
 * BullMQ needs a Redis, which this environment does not have, so the adapter takes
 * an injected queue handle typed by the subset it calls. What is worth checking
 * without Redis is exactly what this suite checks: that the adapter is a
 * translation and not a second place where the Requirement 6.2 numbers live.
 */

interface FakeBullQueue extends BullQueueHandle {
  readonly added: readonly { readonly name: string; readonly options?: BullJobOptions }[];
  readonly removed: readonly string[];
}

function createFakeBullQueue(): FakeBullQueue {
  const waiting: { id?: string | null }[] = [];
  const added: { name: string; options?: BullJobOptions }[] = [];
  const removed: string[] = [];

  return {
    added,
    removed,
    async add(name, _data, options) {
      added.push(options === undefined ? { name } : { name, options });
      const job = { id: options?.jobId ?? null };
      waiting.push(job);
      return job;
    },
    async getWaitingCount() {
      return waiting.length;
    },
    async getWaiting() {
      return waiting;
    },
    async remove(jobId) {
      const index = waiting.findIndex((job) => job.id === jobId);
      if (index === -1) return 0;
      waiting.splice(index, 1);
      removed.push(jobId);
      return 1;
    },
  };
}

describe('BullMQ job options', () => {
  it('derives the Requirement 6.2 retry configuration from the domain policy', () => {
    const options = bullMqJobOptions('job-1');

    expect(options.jobId).toBe('job-1');
    // The original attempt plus the three re-requests Requirement 6.2 permits.
    expect(options.attempts).toBe(MAX_ENGINE_RETRY_ATTEMPTS + 1);
    expect(options.backoff).toEqual({ type: 'exponential', delay: MIN_RETRY_DELAY_MS });
  });

  it('produces the same schedule BullMQ would from these options', () => {
    const { delay } = bullMqJobOptions('job-1').backoff ?? { delay: 0 };
    const expected = Array.from(
      { length: MAX_ENGINE_RETRY_ATTEMPTS },
      (_unused, index) => delay * 2 ** index,
    );

    expect(expected).toEqual([...retryScheduleMs()]);
  });
});

describe('BullMQ queue adapter', () => {
  it('reports 1-based positions and removes by job id', async () => {
    const handle = createFakeBullQueue();
    const queue = createBullMqJobQueue(handle);

    expect(await queue.enqueue('job-1')).toEqual({ jobId: 'job-1', position: 1 });
    expect(await queue.enqueue('job-2')).toEqual({ jobId: 'job-2', position: 2 });
    expect(await queue.positionOf('job-2')).toBe(2);
    expect(await queue.depth()).toBe(2);

    expect(await queue.remove('job-1')).toBe(true);
    expect(await queue.positionOf('job-2')).toBe(1);
    expect(await queue.remove('missing')).toBe(false);
  });

  it('adds to the one named queue', async () => {
    const handle = createFakeBullQueue();

    await createBullMqJobQueue(handle).enqueue('job-1');

    expect(handle.added[0]?.name).toBe(GENERATION_JOB_QUEUE_NAME);
  });

  it('reports no position for a job that is not waiting', async () => {
    const queue = createBullMqJobQueue(createFakeBullQueue());

    expect(await queue.positionOf('never-added')).toBeNull();
  });
});
