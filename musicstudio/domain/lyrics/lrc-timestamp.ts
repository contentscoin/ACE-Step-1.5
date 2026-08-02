/**
 * The `[mm:ss.xx]` timestamp field (Requirements 10.2, 10.6).
 *
 * One module for one decision — how a millisecond offset and its printed form
 * convert — so that the printer, the parser and the ±10 ms tolerance of Requirement
 * 10.4 all read the same rule.
 *
 * Printing is stricter than parsing, deliberately:
 *
 * - **Printing** always produces exactly `[mm:ss.xx]`: two minute digits, two second
 *   digits, two centisecond digits. That is the literal shape Requirement 10.2 names.
 * - **Parsing** additionally accepts one to three minute digits, a three-digit
 *   fraction (millisecond precision, which some tools emit) and `:` in place of `.`
 *   as the fraction separator (which others emit). Widening the accepted set costs
 *   nothing — Requirement 10.3 only asks that LRC text be readable — and it cannot
 *   affect the round trip, because the round trip starts from *printed* text, which
 *   is always in the narrow form.
 *
 * The quantisation is a **round**, not a truncation. Truncating would bias every
 * timestamp early by up to 9 ms and spend almost the whole of Requirement 10.4's
 * 10 ms budget on a choice with no upside; rounding caps the error at 5 ms.
 */

import { LRC_TIMESTAMP_QUANTUM_MS } from './timed-lyrics';

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;

/** Nearest centisecond, in milliseconds. */
export function quantiseToLrcResolution(startMs: number): number {
  return Math.round(startMs / LRC_TIMESTAMP_QUANTUM_MS) * LRC_TIMESTAMP_QUANTUM_MS;
}

/** Requirement 10.2's `[mm:ss.xx]`, brackets included. */
export function formatLrcTimestamp(startMs: number): string {
  const quantised = quantiseToLrcResolution(Math.max(0, startMs));
  const minutes = Math.floor(quantised / MS_PER_MINUTE);
  const seconds = Math.floor((quantised % MS_PER_MINUTE) / MS_PER_SECOND);
  const centiseconds = Math.floor((quantised % MS_PER_SECOND) / LRC_TIMESTAMP_QUANTUM_MS);

  return `[${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}]`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A leading timestamp and everything after it.
 *
 * Only the *first* timestamp is consumed. Some LRC files repeat a line under several
 * timestamps on one physical line (`[00:10.00][01:20.00]chorus`); that form is not
 * part of the supported subset, and reading only the first bracket is what keeps the
 * round trip total — a line whose *text* legitimately begins with something
 * bracket-shaped then survives instead of being re-read as a second timestamp.
 */
const TIMESTAMP_PREFIX = /^\[(\d{1,3}):([0-5]\d)(?:[.:](\d{2,3}))?\]/u;

/**
 * An LRC metadata tag such as `[ti:Title]`, `[ar:Artist]` or `[offset:+250]`.
 *
 * Recognised so that a real-world file does not fail Requirement 10.6's malformed
 * check on a line that is in fact perfectly well formed — it simply is not a
 * timestamp. It never collides with a timestamp line, since a timestamp's first
 * character inside the bracket is a digit and a metadata key's is a letter.
 */
const METADATA_TAG = /^\[[a-zA-Z][a-zA-Z0-9_]*:[^\]]*\]$/u;

export type LrcLineReading =
  | { readonly kind: 'timed'; readonly startMs: number; readonly text: string }
  | { readonly kind: 'metadata'; readonly tag: string }
  | { readonly kind: 'blank' }
  /** Starts with `[` but the bracket is not a timestamp or a metadata tag. */
  | { readonly kind: 'malformed_timestamp' }
  /** Carries text but no timestamp at all. */
  | { readonly kind: 'missing_timestamp' };

/**
 * Classifies one physical line. Total, and the single place a line's kind is decided.
 *
 * `text` is returned **verbatim**, with no trimming. A conventional LRC line puts a
 * space after the bracket, so trimming would be tempting — but it would make any
 * line whose text genuinely starts with a space unrecoverable, and Requirement 10.4
 * is a claim about *all* valid `Timed_Lyrics`, not about the ones that happen to be
 * already trimmed. The printer correspondingly emits no separator space.
 */
export function readLrcLine(rawLine: string): LrcLineReading {
  const trimmed = rawLine.trim();
  if (trimmed === '') return { kind: 'blank' };

  // Leading whitespace before the bracket is tolerated; the printer never emits it.
  const candidate = rawLine.replace(/^\s+/u, '');
  const match = TIMESTAMP_PREFIX.exec(candidate);

  if (match !== null) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fraction = match[3];
    const fractionMs =
      fraction === undefined
        ? 0
        : fraction.length === 2
          ? Number(fraction) * LRC_TIMESTAMP_QUANTUM_MS
          : Number(fraction);

    return {
      kind: 'timed',
      startMs: minutes * MS_PER_MINUTE + seconds * MS_PER_SECOND + fractionMs,
      text: candidate.slice(match[0].length),
    };
  }

  if (METADATA_TAG.test(trimmed)) return { kind: 'metadata', tag: trimmed };

  return trimmed.startsWith('[')
    ? { kind: 'malformed_timestamp' }
    : { kind: 'missing_timestamp' };
}
