/**
 * Decoding Woosh's envelope and status responses.
 *
 * Separate from the adapter for the reason `adapters/ace/query-result.ts` is: decoding is
 * total and testable on its own, and every malformed shape has a named rejection instead of
 * a `TypeError` from a property access on `undefined`.
 *
 * The status vocabulary is design §3.1's: 0 running, 1 succeeded, 2 failed. Anything the
 * engine reports that is not one of those three is failure — an adapter that guessed
 * "probably still running" for an unrecognised status would hold a job open forever.
 */

import { ENGINE_JOB_STATE, type EngineJobState } from '../engine-job';

import {
  wooshApplicationError,
  wooshHttpError,
  wooshMalformedResponse,
} from './errors';
import type { WooshJsonResponse } from './transport';

/** The application-level success code. Anything else is an application error. */
export const WOOSH_OK_CODE = 200;

/**
 * The `data` of a successful envelope.
 *
 * Throws rather than returning a union, because every caller's next step is to read a field
 * off it: a `null` return would push the same check into three places.
 */
export function unwrapWooshEnvelope(path: string, response: WooshJsonResponse): unknown {
  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    throw wooshHttpError(response.httpStatus, path);
  }

  const { code, error } = response.envelope;
  // A code is optional; when present it must be the success code. This is the distinction
  // `adapters/ace` also makes — HTTP 200 carrying an application failure is a real case and
  // must not read as success.
  if (code !== undefined && code !== WOOSH_OK_CODE) {
    throw wooshApplicationError(path, code, error);
  }
  if (error !== undefined && error !== null && error !== '') {
    throw wooshApplicationError(path, code, error);
  }

  return response.envelope.data;
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** The submit acknowledgement: a task identifier and nothing else that matters yet. */
export function decodeWooshSubmitAck(path: string, data: unknown): { readonly taskId: string } {
  const record = asRecord(data);
  const taskId = record?.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw wooshMalformedResponse(path, 'Woosh did not return a task identifier.');
  }
  return { taskId };
}

/** One produced sample, as the status route describes it. */
export interface WooshResultEntry {
  /** Path the binary route serves this sample from. `null` while unfinished. */
  readonly filePath: string | null;
  readonly seed: number | null;
  readonly durationMs: number | null;
  /**
   * Requirement 22.6's prompt-audio alignment score, as the engine reports it.
   *
   * `null` when the engine did not report one, which the service treats as an unscored
   * candidate rather than a failure — see `services/sound/sfx-ports.ts`.
   */
  readonly alignmentScore: number | null;
}

export interface WooshTaskResult {
  readonly statusCode: number;
  readonly progressPercent: number | null;
  readonly failureReason: string | null;
  readonly entries: readonly WooshResultEntry[];
}

/**
 * The status of one task.
 *
 * Returns `null` when the response contains no entry for `engineJobId`, which the adapter
 * turns into `woosh_task_unknown`: a task the engine has forgotten is not a task that is
 * still running.
 */
export function decodeWooshTaskResult(
  path: string,
  data: unknown,
  engineJobId: string,
): WooshTaskResult | null {
  const record = asRecord(data);
  if (record === null) throw wooshMalformedResponse(path, 'Woosh returned no task object.');

  const entry = findTask(record, engineJobId);
  if (entry === null) return null;

  const status = entry.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    throw wooshMalformedResponse(path, 'Woosh returned a task with no integer status.');
  }

  const samples = Array.isArray(entry.samples) ? entry.samples : [];

  return {
    statusCode: status,
    progressPercent: numberOrNull(entry.progress),
    failureReason: typeof entry.error === 'string' && entry.error !== '' ? entry.error : null,
    entries: samples.map((sample) => decodeSample(asRecord(sample))),
  };
}

/**
 * The task carrying `engineJobId`, in either of the two shapes the route may use.
 *
 * A batch response holds `tasks: [...]`; a single-task response is the task object itself.
 * Both are accepted because the envelope is unverified (see `transport.ts`) and accepting
 * both costs one branch, whereas guessing wrong would fail every poll.
 */
function findTask(
  record: Readonly<Record<string, unknown>>,
  engineJobId: string,
): Readonly<Record<string, unknown>> | null {
  const tasks = record.tasks;
  if (Array.isArray(tasks)) {
    return tasks.map(asRecord).find((task) => task?.task_id === engineJobId) ?? null;
  }
  return record.task_id === engineJobId ? record : null;
}

function decodeSample(sample: Readonly<Record<string, unknown>> | null): WooshResultEntry {
  return {
    filePath: typeof sample?.path === 'string' && sample.path !== '' ? sample.path : null,
    seed: numberOrNull(sample?.seed),
    durationMs: numberOrNull(sample?.duration_ms),
    alignmentScore: numberOrNull(sample?.alignment_score),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 0, 1 and 2 are the only states `EngineJobStatus` admits; anything else is failure. */
export function wooshEngineStateOf(statusCode: number): EngineJobState {
  if (statusCode === ENGINE_JOB_STATE.running) return ENGINE_JOB_STATE.running;
  if (statusCode === ENGINE_JOB_STATE.succeeded) return ENGINE_JOB_STATE.succeeded;
  return ENGINE_JOB_STATE.failed;
}
