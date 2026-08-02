/**
 * The failure shape every parser in the product layer returns (design §7.2).
 *
 * Design §7.2 specifies one structure for all five parsers of §7.1 — Lyrics, LRC,
 * Timeline_Project, Effect_Chain and Cue_Pack_Manifest — so it lives here rather
 * than beside any one of them. The fields are deliberately all-optional except
 * `violation`, because the five parsers locate a fault differently: a text parser
 * knows a line number, a structured-document parser knows an array index, and both
 * may or may not know a field name.
 *
 * Two rules make the type useful rather than decorative:
 *
 * - `violation` is a stable machine-readable code, never a sentence. Requirement
 *   10.6 asks for "the violation" alongside the line number, and a client that
 *   wants to branch on the cause needs a token it can compare.
 * - `line` is **1-based**, matching what an editor shows the user. Requirement 10.6
 *   exists so a person can find the offending line, and a 0-based index would send
 *   them one line too high.
 *
 * Parsers return these rather than throwing: a document can hold several
 * independent faults and reporting them one exception at a time turns a single fix
 * into several round trips.
 */
export interface ParseError {
  /** 1-based line number of the offending line (LRC, Lyrics). */
  readonly line?: number;
  /** Index of the offending array element (Effect_Chain, Manifest). */
  readonly index?: number;
  /** Name of the offending field. */
  readonly field?: string;
  /** Stable violation code, e.g. `lrc_timestamp_malformed`. */
  readonly violation: string;
  /** Human-readable description of what would have been accepted. */
  readonly expected?: string;
  /** The input as received, so the caller can echo it back to the user. */
  readonly actual?: string;
}

/**
 * A parse outcome: the value, or the complete list of faults.
 *
 * A discriminated union rather than `T | ParseError[]` so that a caller cannot
 * forget to check — `result.ok` has to be narrowed before `result.value` exists.
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly ParseWarning[] }
  | { readonly ok: false; readonly errors: readonly ParseError[] };

/**
 * A recoverable observation made while parsing.
 *
 * Requirement 9.4 needs exactly this: an unrecognised bracket tag is *preserved*
 * rather than rejected, and the caller is told about it. That is not an error — the
 * parse succeeded — so it cannot travel in `errors` without making a successful
 * parse look like a failed one.
 */
export interface ParseWarning {
  readonly line?: number;
  readonly index?: number;
  readonly code: string;
  readonly message: string;
  readonly actual?: string;
}

export function parseFailure<T>(...errors: readonly ParseError[]): ParseResult<T> {
  return { ok: false, errors };
}

export function parseSuccess<T>(
  value: T,
  warnings: readonly ParseWarning[] = [],
): ParseResult<T> {
  return { ok: true, value, warnings };
}

/** One line per error, for logs and for the gateway's error payload. */
export function describeParseError(error: ParseError): string {
  const where = [
    error.line === undefined ? null : `line ${String(error.line)}`,
    error.index === undefined ? null : `index ${String(error.index)}`,
    error.field === undefined ? null : `field ${error.field}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  const detail = error.expected === undefined ? '' : ` (expected ${error.expected})`;
  return where === '' ? `${error.violation}${detail}` : `${where}: ${error.violation}${detail}`;
}
