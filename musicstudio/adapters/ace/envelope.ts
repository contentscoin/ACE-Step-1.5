/**
 * Unwrapping the ACE-Step response envelope.
 *
 * The engine wraps every JSON answer as `{ data, code, error, timestamp, extra }`
 * and reports application failures *inside* a 200 response by setting `code` to
 * something other than 200 and filling `error`. A caller that only checked the
 * HTTP status would therefore read a failure as a success, so both are checked
 * here, in one place, and every route goes through it.
 */

import { aceApplicationError, aceHttpError } from './errors';
import type { AceJsonResponse } from './transport';

const OK_APPLICATION_CODE = 200;

/**
 * Returns the envelope's `data`, or throws.
 *
 * The two failure modes are distinguished on purpose: a transport-level status is
 * preserved as-is (Requirement 6.2 keys on 429), while an application-level error
 * inside a 200 becomes a 502, because that is what it is — the engine is reachable
 * and refusing.
 */
export function unwrapEnvelope(path: string, response: AceJsonResponse): unknown {
  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    return failWithHttpStatus(path, response);
  }

  const { code, error } = response.envelope;
  const codeIsOk = code === undefined || code === null || code === OK_APPLICATION_CODE;
  const errorIsAbsent = error === undefined || error === null || error === '';

  if (!codeIsOk || !errorIsAbsent) {
    throw aceApplicationError(path, code, error);
  }
  return response.envelope.data;
}

function failWithHttpStatus(path: string, response: AceJsonResponse): never {
  const detail = response.envelope.error;
  throw aceHttpError(
    response.httpStatus,
    path,
    typeof detail === 'string' ? detail : undefined,
  );
}

/** Narrows unknown envelope data to an object without asserting its fields. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Trimmed string, or `null` for absent/blank/`"N/A"` — the engine's empty marker. */
export function asReportedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'N/A') return null;
  return trimmed;
}
