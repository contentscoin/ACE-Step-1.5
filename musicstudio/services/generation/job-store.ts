/**
 * Generation_Job storage port.
 *
 * Design §2.4 assigns Generation_Job custody to the task queue (BullMQ on Redis),
 * and design §4.1's ER diagram has no Generation_Job table, so this task adds no
 * migration. What it does add is the seam: a four-method port with an in-memory
 * implementation. A durable store (a Postgres-backed one for the task 8.2
 * diagnostics view, say) becomes a second implementation, not a rewrite.
 *
 * `nonTerminal()` exists for the Requirement 5.8 sweep, which needs the candidate
 * set without scanning every job that ever ran.
 */

import { isTerminalGenerationJobState } from '../../domain/generation-job/lifecycle';

import type { GenerationJobRecord } from './job-record';

export interface JobStorePort {
  save(record: GenerationJobRecord): Promise<void>;
  find(jobId: string): Promise<GenerationJobRecord | undefined>;
  /** Candidates for the Requirement 5.8 timeout sweep. */
  nonTerminal(): Promise<readonly GenerationJobRecord[]>;
  ofAccount(accountId: string): Promise<readonly GenerationJobRecord[]>;
}

export function createInMemoryJobStore(): JobStorePort {
  const records = new Map<string, GenerationJobRecord>();

  return {
    async save(record) {
      records.set(record.jobId, record);
    },
    async find(jobId) {
      return records.get(jobId);
    },
    async nonTerminal() {
      return [...records.values()].filter(
        (record) => !isTerminalGenerationJobState(record.lifecycle.state),
      );
    },
    async ofAccount(accountId) {
      return [...records.values()].filter((record) => record.accountId === accountId);
    },
  };
}
