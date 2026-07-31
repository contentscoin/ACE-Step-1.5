/**
 * Decoding the `/release_task` acknowledgement.
 *
 * The engine answers `{ task_id, status: "queued", queue_position }` inside its
 * envelope (`release_task_route.py`). `task_id` is the identifier Requirement 5.1
 * stores and every later poll, fetch and cancel is keyed by, so a response without
 * one is a hard failure rather than something to work around.
 */

import { asFiniteNumber, asRecord } from './envelope';
import { aceMalformedResponse } from './errors';

export interface AceSubmitAck {
  readonly taskId: string;
  /** 1-based position the engine reported, when it reported one. */
  readonly queuePosition: number | null;
}

export function decodeSubmitAck(path: string, data: unknown): AceSubmitAck {
  const record = asRecord(data);
  if (record === null) {
    throw aceMalformedResponse(path, 'ACE-Step returned no object for a submitted task.');
  }

  const taskId = record.task_id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw aceMalformedResponse(path, 'ACE-Step returned a task without an identifier.');
  }

  return { taskId, queuePosition: asFiniteNumber(record.queue_position) };
}
