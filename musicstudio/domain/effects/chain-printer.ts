/**
 * `Chain_Printer` (Requirements 29.24, 29.11, 29.27).
 *
 * Converts an `Effect_Chain` to a JSON document. Two decisions carry the weight of
 * Requirement 29.27's "1회 출력 문서와 2회 출력 문서를 바이트 단위로 동일하게 산출"
 * — the two documents must be **byte-identical**, which is a stronger promise than the
 * equivalence relation and needs the output to be a function of the chain alone.
 *
 * **1. Key order is fixed, not inherited.** Item keys are always `kind` then
 * `parameters`, and parameter keys are always in registry order. `JSON.stringify`
 * preserves insertion order, so a chain built by hand with the keys the other way round
 * would otherwise print differently from the same chain after a parse. `chain.ts`
 * normalises parameter order when a chain enters the domain and this module fixes item
 * key order, so the byte-identity of 29.27 holds for a structural reason rather than
 * because callers were careful.
 *
 * **2. Numbers are printed by `JSON.stringify`, unmodified.** No rounding, no fixed
 * decimal count. `JSON.stringify` uses the shortest round-trip representation of a
 * double, so `JSON.parse(JSON.stringify(x)) === x` exactly for every finite `x`. Any
 * "tidying" here — `toFixed(6)`, say — would *introduce* the drift that Requirement
 * 29.26's 1e-6 tolerance is there to absorb, and would make a second print of the
 * reparsed chain differ from the first. The tolerance exists for chains that arrive
 * from elsewhere, not as licence for this printer to lose precision.
 *
 * There is no trailing newline. Unlike a `.lrc` file (Requirement 10.8), a chain is a
 * JSON value stored in a `jsonb` column and embedded in API payloads, not a
 * downloadable text file; a trailing byte would have to be tolerated by every consumer
 * and would be a second thing to keep identical across two prints.
 */

import type { EffectChain, EffectItem } from './chain';
import { parameterNames } from './registry';

/** The wire shape of one item. Exported for the parser's benefit and for tests. */
export interface EffectItemDocument {
  readonly kind: string;
  readonly parameters: Record<string, number>;
}

/**
 * Requirement 29.11: an order-preserving JSON array.
 *
 * Returns the plain JS value rather than a string, for the caller that is about to put
 * it in a `jsonb` column or nest it in a larger payload and would otherwise parse the
 * string straight back.
 */
export function chainToDocument(chain: EffectChain): EffectItemDocument[] {
  return chain.items.map(itemToDocument);
}

function itemToDocument(item: EffectItem): EffectItemDocument {
  const parameters: Record<string, number> = {};
  // Registry order, not `Object.keys(item.parameters)` order. `chain.ts` already
  // normalises, so for a domain-constructed chain these agree; going through the
  // registry again means a chain assembled by a future caller that skipped
  // normalisation still prints canonically instead of printing its own key order.
  for (const name of parameterNames(item.kind)) {
    parameters[name] = item.parameters[name] as number;
  }
  return { kind: item.kind, parameters };
}

/** Requirement 29.24: the chain as a JSON document string. */
export function printChain(chain: EffectChain): string {
  return JSON.stringify(chainToDocument(chain));
}

/**
 * The same document, indented for a human reader.
 *
 * Separate from `printChain` rather than an option on it, because Requirement 29.27's
 * byte-identity is asserted against `printChain`'s output and a formatting flag
 * threaded through call sites is a way for a stored chain to acquire whitespace that
 * differs from the one it is compared against.
 */
export function printChainPretty(chain: EffectChain): string {
  return JSON.stringify(chainToDocument(chain), null, 2);
}
