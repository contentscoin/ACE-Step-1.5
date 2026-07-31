/**
 * Work-queue port (design §2.4; Requirements 5.1, 5.5).
 *
 * The chosen queue is BullMQ on Redis, and Redis is not something a unit test
 * should need. So the queue is a port: `bullmq-queue.ts` is the thin production
 * translation, and the in-memory implementation below is what every test uses.
 * The queue's job here is narrow — it hands out the waiting position Requirement
 * 5.1 returns and Requirement 5.5 turns into an ETA. It holds no lifecycle state;
 * that is the state machine's.
 *
 * Positions are 1-based, matching `domain/generation-job/eta.ts`.
 */

export interface QueuePlacement {
  readonly jobId: string;
  /** 1-based position at the moment of enqueueing. */
  readonly position: number;
}

export interface JobQueuePort {
  /** Adds a pending job to the tail and reports its position. */
  enqueue(jobId: string): Promise<QueuePlacement>;
  /** Current 1-based position, or `null` once the job is no longer waiting. */
  positionOf(jobId: string): Promise<number | null>;
  /** Number of jobs still waiting. */
  depth(): Promise<number>;
  /** Removes a job (started, cancelled or otherwise terminal). */
  remove(jobId: string): Promise<boolean>;
}

export function createInMemoryJobQueue(): JobQueuePort {
  const waiting: string[] = [];

  return {
    async enqueue(jobId) {
      if (!waiting.includes(jobId)) waiting.push(jobId);
      return { jobId, position: waiting.indexOf(jobId) + 1 };
    },
    async positionOf(jobId) {
      const index = waiting.indexOf(jobId);
      return index === -1 ? null : index + 1;
    },
    async depth() {
      return waiting.length;
    },
    async remove(jobId) {
      const index = waiting.indexOf(jobId);
      if (index === -1) return false;
      waiting.splice(index, 1);
      return true;
    },
  };
}
