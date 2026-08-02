/**
 * `Chain_Parser` (Requirements 29.25, 29.33).
 *
 * Turns a JSON document into an `Effect_Chain`, or returns the faults in design §7.2's
 * `ParseError` shape. It shares that shape with the four other parsers of §7.1, which
 * is why the error type lives in `domain/parse-error.ts` rather than here.
 *
 * ### What Requirement 29.33 asks for, precisely
 *
 * > THEN THE Chain_Parser SHALL 변환을 거부하고 **첫 위반 항목의 배열 인덱스와 위반
 * > 사유**를 반환하며 Effect_Chain을 산출하지 않는다
 *
 * The first violation's array index and reason — singular. So this parser returns
 * exactly one `ParseError` on failure, taken as the first element of `chainViolations`,
 * even though that function computes the whole list. The two therefore cannot disagree
 * about *which* fault is first: there is one ordering, defined in one place.
 *
 * `chainViolations`'s full list is still the right thing for the *service* to use when
 * validating a chain that arrived as structured data rather than as a document
 * (Requirements 29.9 and 29.10 place no "first only" limit on `Effects_Service`), which
 * is why `chain.ts` exposes both and this module narrows rather than replaces.
 *
 * ### Two input forms
 *
 * `parseChainDocument` takes a JSON **string** — the form Requirement 29.33 describes,
 * including the case where the text is not JSON at all. `parseChainValue` takes an
 * already-decoded value, which is what a `jsonb` column read and an API request body
 * both hand over; routing those through a re-serialise/re-parse just to reuse one
 * function would be able to fail for reasons the input never had.
 */

import {
  parseFailure,
  parseSuccess,
  type ParseError,
  type ParseResult,
} from '../parse-error';
import { chainViolations, toChain, type ChainViolation, type EffectChain } from './chain';

/** Requirement 29.33: reject a document that is not JSON, or not a valid chain. */
export function parseChainDocument(document: string): ParseResult<EffectChain> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(document);
  } catch {
    // Not `chain_not_array`: the input never got as far as being a JSON value, and
    // saying "expected an array" about `{oops` would send the caller looking in the
    // wrong place.
    return parseFailure({
      index: 0,
      violation: 'chain_json_malformed',
      expected: 'a JSON array of effect items',
      actual: truncate(document),
    });
  }
  return parseChainValue(decoded);
}

/** The same rules against an already-decoded value (a `jsonb` read, a request body). */
export function parseChainValue(value: unknown): ParseResult<EffectChain> {
  const violations = chainViolations(value);
  const first = violations[0];
  if (first !== undefined) return parseFailure(toParseError(first));
  return parseSuccess(toChain(value));
}

/**
 * §7.2's `ParseError` from a `ChainViolation`.
 *
 * `index` and `violation` carry across unchanged — they are what Requirement 29.33
 * names. `field` carries the offending kind or parameter name, which is what
 * Requirements 29.9 and 29.10 require be *returned*; `expected` carries 29.10's
 * permitted range. `line` is left unset: a JSON document has no meaningful line for a
 * structural fault, and populating it with `1` would be a lie a client might display.
 */
function toParseError(violation: ChainViolation): ParseError {
  return {
    index: violation.index,
    violation: violation.violation,
    ...(violation.name === undefined ? {} : { field: violation.name }),
    ...(violation.permittedRange === undefined ? {} : { expected: violation.permittedRange }),
    ...(violation.actual === undefined ? {} : { actual: violation.actual }),
  };
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
