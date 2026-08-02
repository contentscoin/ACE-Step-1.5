/**
 * Decoding helpers shared by the two TTS adapters.
 *
 * Only the parts that are genuinely *not* engine-specific live here: reading an unknown value as
 * a record, reading a number, mapping a numeric state onto design §3.1's 0/1/2, and pulling the
 * validated parameters and seed off a normalised request. Each engine's own envelope shape,
 * field names and state vocabulary stay in its own adapter, because that is the thing the two
 * differ in and the reason the abstraction exists.
 */

import { ENGINE_JOB_STATE, type EngineJobState } from '../engine-job';
import type { NormalizedGenerationRequest } from '../normalized-generation';
import type { SpeechParameters } from '../../domain/speech/request';

import { ttsMalformedResponse } from './errors';

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Design §3.1's 0/1/2, from an engine that reports numbers.
 *
 * An unknown or absent value is `running`, not `failed`. A status route that answered something
 * unexpected has not said the job failed, and treating it as a failure would refund a job that is
 * still working — the Requirement 6.5 unreachable-streak path is what handles a status route
 * that keeps answering nothing useful.
 */
export function engineStateFromNumeric(state: number | null): EngineJobState {
  if (state === ENGINE_JOB_STATE.succeeded) return ENGINE_JOB_STATE.succeeded;
  if (state === ENGINE_JOB_STATE.failed) return ENGINE_JOB_STATE.failed;
  return ENGINE_JOB_STATE.running;
}

/**
 * Design §3.1's 0/1/2, from an engine that reports strings.
 *
 * Engine B's vocabulary. The same "unknown means running" rule as above, for the same reason.
 */
export function engineStateFromText(state: unknown): EngineJobState {
  if (state === 'succeeded' || state === 'completed') return ENGINE_JOB_STATE.succeeded;
  if (state === 'failed' || state === 'error' || state === 'cancelled') {
    return ENGINE_JOB_STATE.failed;
  }
  return ENGINE_JOB_STATE.running;
}

/** The validated dialogue parameters a `dialogue` request must carry. */
export function speechParametersOf(
  path: string,
  request: NormalizedGenerationRequest,
): SpeechParameters {
  const parameters = request.speech;
  if (parameters === undefined) {
    throw ttsMalformedResponse(
      path,
      'a TTS submission needs validated dialogue parameters; none were carried on the request',
    );
  }
  return parameters;
}

/** Requirement 25.18: a submission always names a seed by the time it reaches an engine. */
export function seedOf(path: string, request: NormalizedGenerationRequest): number {
  const seed = request.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) {
    throw ttsMalformedResponse(
      path,
      'a TTS submission needs an integer seed; Requirement 25.18 draws one when the caller names none',
    );
  }
  return seed;
}
