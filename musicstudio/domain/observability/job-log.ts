/**
 * The structured log every Generation_Job produces (Requirement 18.5, design §11.2).
 *
 * > THE MusicStudio SHALL 모든 Generation_Job에 대해 요청 식별자, 사용자 식별자, 엔진 식별자,
 * > 엔진 작업 식별자, 사용 모델, 소요 시간을 구조화된 로그로 기록한다
 *
 * ### The type is what keeps Requirement 18.8 true, not a review
 *
 * 18.8 says an email or an API key in a log or an alert must be masked. The way that clause is
 * usually broken is not by logging `user.email` on purpose — it is by widening a log record with
 * a `context` or `metadata` bag, and someone spreading a request object into it a year later.
 *
 * So `JobLogRecord` is **closed**: exactly the nine fields design §11.2 lists, all primitives,
 * with no open-ended member. There is nowhere to put a raw address. `buildJobLog` takes the
 * account's email and key as *optional* inputs and masks them on the way in, so a caller who has
 * them cannot pass them through unmasked either.
 *
 * `test/property/log-masking.test.ts` generates records from arbitrary inputs — including strings
 * that look like emails and keys — and asserts nothing unmasked survives.
 */

import { isMaskedApiKey, isMaskedEmail, maskApiKey, maskEmail } from '../audit-log/masking';

/** Design §11.2's `status` values: what the log says happened. */
export const JOB_LOG_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobLogStatus = (typeof JOB_LOG_STATUSES)[number];

/**
 * Design §11.2's nine fields, and no tenth.
 *
 * `engineJobId` and `modelName` are nullable because a job refused before it reached an engine
 * has neither, and a log line that omitted the field entirely would make "which jobs never
 * reached an engine" a question about absent keys rather than about null values.
 */
export interface JobLogRecord {
  readonly requestId: string;
  readonly userId: string;
  readonly engineId: string | null;
  readonly engineJobId: string | null;
  readonly modelName: string | null;
  readonly durationMs: number;
  readonly assetKind: string;
  readonly status: JobLogStatus;
  /** Millisecond epoch. A number rather than a `Date` so the record is JSON as it stands. */
  readonly timestampMs: number;
  /** Requirement 18.8 — masked on the way in, never raw. Absent when the caller had none. */
  readonly actorEmailMasked?: string;
  readonly apiKeyMasked?: string;
}

export interface JobLogInput {
  readonly requestId: string;
  readonly userId: string;
  readonly engineId?: string | null;
  readonly engineJobId?: string | null;
  readonly modelName?: string | null;
  readonly durationMs: number;
  readonly assetKind: string;
  readonly status: JobLogStatus;
  readonly timestampMs: number;
  /** Raw. Masked here so no call site has to remember — the same shape `AuditLogDraft` uses. */
  readonly actorEmail?: string | null;
  readonly apiKey?: string | null;
}

/**
 * Build the record. Total: a malformed email or key degrades to a fully masked value rather
 * than throwing, because a throw at a logging call site is the one failure that pushes a caller
 * into logging the raw value instead.
 */
export function buildJobLog(input: JobLogInput): JobLogRecord {
  return {
    requestId: input.requestId,
    userId: input.userId,
    engineId: input.engineId ?? null,
    engineJobId: input.engineJobId ?? null,
    modelName: input.modelName ?? null,
    // Negative durations are a clock going backwards, not a fast job. Clamped rather than
    // rejected: a log line is not the place to fail, and a negative duration in a percentile
    // is worse than a zero.
    durationMs: Math.max(0, Math.round(input.durationMs)),
    assetKind: input.assetKind,
    status: input.status,
    timestampMs: input.timestampMs,
    ...(input.actorEmail == null ? {} : { actorEmailMasked: maskEmail(input.actorEmail) }),
    ...(input.apiKey == null ? {} : { apiKeyMasked: maskApiKey(input.apiKey) }),
  };
}

/**
 * Whether a record is safe to emit (Requirement 18.8).
 *
 * A second gate after `buildJobLog`, and it exists because the builder is not the only way a
 * record can come into being — a deserialised one, a hand-written one in a test, a record from
 * a future call site that constructed the literal. The emitter checks this rather than trusting
 * that everything went through the builder.
 */
export function isEmittableJobLog(record: JobLogRecord): boolean {
  if (record.actorEmailMasked !== undefined && !isMaskedEmail(record.actorEmailMasked)) {
    return false;
  }
  if (record.apiKeyMasked !== undefined && !isMaskedApiKey(record.apiKeyMasked)) return false;
  return true;
}

/** Design §11.2's `user_id` etc. — the wire form, snake_case, one place. */
export function toWireFields(record: JobLogRecord): Readonly<Record<string, unknown>> {
  return {
    request_id: record.requestId,
    user_id: record.userId,
    engine_id: record.engineId,
    engine_job_id: record.engineJobId,
    model_name: record.modelName,
    duration_ms: record.durationMs,
    asset_kind: record.assetKind,
    status: record.status,
    timestamp: new Date(record.timestampMs).toISOString(),
    ...(record.actorEmailMasked === undefined ? {} : { actor_email: record.actorEmailMasked }),
    ...(record.apiKeyMasked === undefined ? {} : { api_key: record.apiKeyMasked }),
  };
}
