/**
 * `Manifest_Parser` (Requirements 24.12, 24.16; design §7.1, §7.2).
 *
 * Turns a manifest document into a `Cue_Pack_Manifest`, or returns the faults in §7.2's
 * `ParseError` shape — the same shape the other four parsers of §7.1 return, which is why
 * it lives in `domain/parse-error.ts` rather than here.
 *
 * ### What Requirement 24.16 asks for, precisely
 *
 * > IF Cue_Pack_Manifest의 큐 항목 개수가 78이 아니면, THEN THE Manifest_Parser SHALL
 * > **항목 개수와 요구 개수를 포함한** 오류를 반환한다
 *
 * Both numbers, in the error. So the count fault carries `actual` (what arrived) and
 * `expected` (78) rather than a message that mentions one of them — a client that wants to
 * say "72 of 78 cues" needs both as data.
 *
 * ### Why every fault is returned, not only the first
 *
 * `Chain_Parser` returns exactly one error, because Requirement 29.33 says "첫 위반 항목"
 * — singular. Requirement 24.16 says no such thing, and a manifest is 78 entries of eight
 * fields: reporting one fault per parse would turn fixing a mis-exported pack into 78 round
 * trips. So the whole list comes back, ordered by `manifestViolations`, and callers that
 * want only the first take `errors[0]`. The count fault, when it applies, is first in that
 * order, which is the one place the ordering is load-bearing.
 *
 * ### Two input forms
 *
 * `parseManifestDocument` takes the document **text**, which is what unzipping an archive
 * yields and what Requirement 24.12 describes, including the case where the text is not
 * JSON at all. `parseManifestValue` takes an already-decoded value — a `jsonb` read, an API
 * body, or the object the export path assembled — for the reason `chain-parser.ts` gives:
 * routing those through a re-serialise just to reuse one function would let a parse fail
 * for a reason the input never had.
 */

import {
  parseFailure,
  parseSuccess,
  type ParseError,
  type ParseResult,
} from '../parse-error';

import { manifestViolations, toManifest, type ManifestViolation } from './manifest';
import type { CuePackManifest } from './manifest';

/** Requirement 24.12: the document text, including "not JSON at all". */
export function parseManifestDocument(document: string): ParseResult<CuePackManifest> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(document);
  } catch {
    // Not `manifest_not_object`: the input never became a JSON value, and telling the
    // caller an object was expected would send them looking at the shape of `{oops`
    // rather than at its syntax.
    return parseFailure({
      violation: 'manifest_json_malformed',
      expected: 'a JSON object with packName and entries',
      actual: truncate(document),
    });
  }
  return parseManifestValue(decoded);
}

/** The same rules against an already-decoded value. */
export function parseManifestValue(value: unknown): ParseResult<CuePackManifest> {
  const violations = manifestViolations(value);
  if (violations.length > 0) return parseFailure(...violations.map(toParseError));
  return parseSuccess(toManifest(value));
}

/**
 * §7.2's `ParseError` from a `ManifestViolation`.
 *
 * `index` and `field` carry across when present; `line` is never set, because a JSON
 * document has no meaningful line for a structural fault and filling it with `1` would be
 * a lie a client might display next to the wrong text.
 */
function toParseError(violation: ManifestViolation): ParseError {
  return {
    ...(violation.index === undefined ? {} : { index: violation.index }),
    ...(violation.field === undefined ? {} : { field: violation.field }),
    violation: violation.violation,
    ...(violation.expected === undefined ? {} : { expected: violation.expected }),
    ...(violation.actual === undefined ? {} : { actual: violation.actual }),
  };
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
