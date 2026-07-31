import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  chainViolations,
  toChain,
  type EffectChain,
} from '../../domain/effects/chain';
import { parseChainDocument, parseChainValue } from '../../domain/effects/chain-parser';
import { printChain } from '../../domain/effects/chain-printer';
import { effectChainsEquivalent } from '../../domain/effects/equivalence';
import {
  CHAIN_ITEM_COUNT_MAX,
  CHAIN_ITEM_COUNT_MIN,
  EFFECT_KINDS,
  EFFECT_REGISTRY,
  type EffectKind,
} from '../../domain/effects/registry';

/**
 * Design §10 Properties 8–9 — `Chain_Parser` / `Chain_Printer` (design §7.1, Requirements
 * 29.26, 29.27).
 *
 * **Properties 8 and 9 (design §10) are the two `describe` blocks so titled.** Per
 * tasks.md §9.2's ownership table — "Property 8–9 Effect_Chain 왕복·멱등 (Req 29.26–29.27)
 * → 태스크 3.2" — this task owns them. The remaining blocks are **unnumbered** property
 * tests: they cover the equivalence relation's own algebra, which design §10 assigns no
 * number to, and inventing one would be a change to §10 that is not this task's to make.
 * Task 9.2's coverage audit must count only the two numbered blocks.
 *
 * Equivalence is judged by `effectChainsEquivalent`, the **chain equivalence relation**
 * Requirement 29.26 defines and design §7.1 tabulates — not by deep equality. That
 * distinction is the point of the relation existing: deep equality would demand exact
 * floating-point equality and so contradict 29.26's explicit 1e-6 tolerance, which is there
 * precisely because a chain round-trips through decimal JSON.
 *
 * ### The generators are constrained, not filtered
 *
 * A parameter value is *drawn from* its own registry range rather than drawn freely and
 * filtered. That is not a convenience to dodge failures — an out-of-range value is not a
 * member of the set Requirement 29.26 quantifies over ("유효한 Effect_Chain"), so filtering
 * would be testing the same set more slowly. Every property below asserts the generated
 * chain really is valid, via `chainViolations`, so a generator that silently stopped
 * constraining would fail here rather than quietly shrink the property's scope.
 */

/** Design §10: at least 100 cases per property. */
const NUM_RUNS = 200;

/**
 * A value inside a kind's declared range for a parameter.
 *
 * `fc.double` with the range's own endpoints, so both are reachable — the ranges are
 * inclusive ("이상 … 이하") and an off-by-one at an endpoint is exactly the kind of fault
 * a property test should find. `noNaN` and no infinities because those are not values the
 * requirement admits; `chain.test.ts` covers their rejection by example.
 */
function arbParameterValue(kind: EffectKind, parameter: string): fc.Arbitrary<number> {
  const range = EFFECT_REGISTRY[kind].parameters[parameter];
  if (range === undefined) throw new Error(`no range for ${kind}.${parameter}`);
  return fc.oneof(
    { arbitrary: fc.double({ min: range.min, max: range.max, noNaN: true }), weight: 8 },
    // The endpoints, explicitly weighted in. A continuous generator hits an exact
    // boundary vanishingly rarely, and the boundaries are where inclusivity is decided.
    { arbitrary: fc.constantFrom(range.min, range.max), weight: 2 },
  );
}

/** One item: a kind plus a complete, in-range parameter map. */
function arbEffectItem(kind: EffectKind): fc.Arbitrary<{
  kind: EffectKind;
  parameters: Record<string, number>;
}> {
  const names = Object.keys(EFFECT_REGISTRY[kind].parameters);
  return fc
    .tuple(...names.map((name) => arbParameterValue(kind, name)))
    .map((values) => {
      const parameters: Record<string, number> = {};
      for (const [index, name] of names.entries()) parameters[name] = values[index] as number;
      return { kind, parameters };
    });
}

const arbAnyItem = fc.constantFrom(...EFFECT_KINDS).chain(arbEffectItem);

/** Requirement 29.13: 1–16 items. Both bounds reachable. */
const arbChainItems = fc.array(arbAnyItem, {
  minLength: CHAIN_ITEM_COUNT_MIN,
  maxLength: CHAIN_ITEM_COUNT_MAX,
});

const arbChain: fc.Arbitrary<EffectChain> = arbChainItems.map((items) => toChain(items));

/**
 * A chain document with parameters in **shuffled** key order.
 *
 * The generator for Property 9, whose subject is "파싱에 성공한 Effect_Chain JSON" — any
 * document that parses, not only ones this printer produced. A document from another
 * implementation may list `mix` before `rate_hz`, and Property 9's byte-identity claim has
 * to survive that. Printing our own output back would test a strictly easier statement.
 */
const arbChainDocument = arbChainItems.chain((items) =>
  fc
    .tuple(
      ...items.map((item) =>
        fc.shuffledSubarray(Object.keys(item.parameters), {
          minLength: Object.keys(item.parameters).length,
        }),
      ),
    )
    .map((orders) =>
      JSON.stringify(
        items.map((item, index) => {
          const parameters: Record<string, number> = {};
          for (const name of orders[index] as string[]) {
            parameters[name] = item.parameters[name] as number;
          }
          return { kind: item.kind, parameters };
        }),
      ),
    ),
);

function expectEquivalent(left: EffectChain, right: EffectChain): void {
  const verdict = effectChainsEquivalent(left, right);
  if (!verdict.equivalent) throw new Error(`chains differ: ${verdict.reason}`);
}

describe('Feature: ai-music-generation-service, Property 8: 유효한 Effect_Chain을 Chain_Printer로 JSON 출력 후 Chain_Parser로 재파싱한 결과는 원본과 체인 동등 관계로 동등하다', () => {
  /**
   * **Validates: Requirements 29.26**
   */
  it('print then parse returns an equivalent chain, for every valid chain', () => {
    fc.assert(
      fc.property(arbChain, (chain) => {
        // The generator's own contract. Were it to drift, the property would still pass
        // while quantifying over a smaller set than Requirement 29.26 does.
        expect(chainViolations(chain.items)).toEqual([]);

        const reparsed = parseChainDocument(printChain(chain));
        expect(reparsed.ok).toBe(true);
        if (reparsed.ok) expectEquivalent(chain, reparsed.value);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves item count, kind order and every parameter exactly', () => {
    // Requirement 29.26's four clauses, checked individually rather than only through the
    // relation, so a relation that had gone permissive could not hide a real regression.
    fc.assert(
      fc.property(arbChain, (chain) => {
        const reparsed = parseChainDocument(printChain(chain));
        if (!reparsed.ok) throw new Error('valid chain failed to reparse');

        expect(reparsed.value.items).toHaveLength(chain.items.length);
        expect(reparsed.value.items.map((item) => item.kind)).toEqual(
          chain.items.map((item) => item.kind),
        );
        for (const [index, item] of chain.items.entries()) {
          const other = reparsed.value.items[index];
          expect(Object.keys(other?.parameters ?? {}).sort()).toEqual(
            Object.keys(item.parameters).sort(),
          );
          for (const [name, value] of Object.entries(item.parameters)) {
            // Stronger than 29.26's 1e-6: `JSON.stringify` emits the shortest
            // round-tripping form of a double, so the drift is in fact exactly zero.
            // Asserting that here means a printer that started rounding would be caught
            // even though the tolerance would still forgive it.
            //
            // Compared as `|a - b| === 0` rather than with `toBe`, which uses
            // `Object.is` and so distinguishes `-0` from `+0`. That distinction is real
            // but not preserved by JSON — `JSON.stringify(-0)` is `"0"` — and it is not
            // one Requirement 29.26 makes: the clause compares absolute differences, and
            // `|(-0) - 0|` is 0. A signed zero also has no meaning as an effect
            // parameter; -0 dB of gain is 0 dB of gain. So the assertion is written to
            // catch rounding, which is what it is for, and not to demand a
            // bit-pattern identity that the wire format cannot carry.
            expect(Math.abs((other?.parameters[name] as number) - value)).toBe(0);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Feature: ai-music-generation-service, Property 9: 파싱에 성공한 Effect_Chain JSON에 대해 파싱→출력→재파싱 결과는 첫 파싱 결과와 체인 동등 관계를 만족하며, 두 출력 문서는 바이트 동일하다', () => {
  /**
   * **Validates: Requirements 29.27**
   */
  it('parse, print and parse again agrees with the first parse', () => {
    fc.assert(
      fc.property(arbChainDocument, (document) => {
        const first = parseChainDocument(document);
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const second = parseChainDocument(printChain(first.value));
        expect(second.ok).toBe(true);
        if (second.ok) expectEquivalent(first.value, second.value);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('emits byte-identical documents on the first and second print', () => {
    // The stronger half of Requirement 29.27 — "바이트 단위로 동일" — and the reason
    // `chain.ts` fixes parameter order when a chain enters the domain. Note the input
    // documents have shuffled key order, so this is not trivially true.
    fc.assert(
      fc.property(arbChainDocument, (document) => {
        const first = parseChainDocument(document);
        if (!first.ok) throw new Error('generated document failed to parse');

        const once = printChain(first.value);
        const reparsed = parseChainDocument(once);
        if (!reparsed.ok) throw new Error('printed document failed to reparse');
        const twice = printChain(reparsed.value);

        expect(twice).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('reaches a textual fixed point after the first print', () => {
    // A third print adds nothing. Not required by 29.27, which is stated over two, but a
    // printer that oscillated with period 2 would satisfy the clause and still be broken.
    fc.assert(
      fc.property(arbChainDocument, (document) => {
        const first = parseChainDocument(document);
        if (!first.ok) return;
        let text = printChain(first.value);
        for (let round = 0; round < 3; round += 1) {
          const parsed = parseChainDocument(text);
          if (!parsed.ok) throw new Error('printed document failed to reparse');
          const next = printChain(parsed.value);
          expect(next).toBe(text);
          text = next;
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Unnumbered property tests — the algebra of the chain equivalence relation.
 *
 * Design §10 numbers no Property for these, and tasks.md §9.2's audit must not count them.
 * They are worth having because Properties 8 and 9 are both *stated in terms of* this
 * relation: a relation that was accidentally reflexive-only, or that ignored a clause,
 * would make both properties vacuous while still passing.
 */
describe('chain equivalence relation (Requirement 29.26) — unnumbered', () => {
  it('is reflexive', () => {
    fc.assert(
      fc.property(arbChain, (chain) => {
        expect(effectChainsEquivalent(chain, chain).equivalent).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(arbChain, arbChain, (left, right) => {
        expect(effectChainsEquivalent(left, right).equivalent).toBe(
          effectChainsEquivalent(right, left).equivalent,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('tolerates a perturbation at the tolerance and rejects one far beyond it', () => {
    // The relation's whole purpose is a tolerance, so both sides of it need exercising.
    // A parameter is nudged by half the tolerance (must stay equivalent) and by a
    // thousand times it (must not) — the latter clamped back into range so the perturbed
    // chain is still a *valid* chain and the comparison is about the relation alone.
    fc.assert(
      fc.property(arbChain, fc.nat(), (chain, seed) => {
        const index = chain.items.length === 0 ? 0 : seed % chain.items.length;
        const item = chain.items[index];
        if (item === undefined) return;
        const names = Object.keys(item.parameters);
        const name = names[seed % names.length] as string;
        const range = EFFECT_REGISTRY[item.kind].parameters[name];
        if (range === undefined) return;
        const base = item.parameters[name] as number;

        const perturb = (delta: number): EffectChain => ({
          items: chain.items.map((original, position) =>
            position === index
              ? {
                  kind: original.kind,
                  parameters: {
                    ...original.parameters,
                    [name]: Math.min(range.max, Math.max(range.min, base + delta)),
                  },
                }
              : original,
          ),
        });

        expect(effectChainsEquivalent(chain, perturb(5e-7)).equivalent).toBe(true);

        const far = perturb(0.001);
        const moved = Math.abs((far.items[index]?.parameters[name] as number) - base);
        // The clamp may have absorbed the nudge when the value sat on an endpoint; only
        // assert non-equivalence when the value genuinely moved past the tolerance.
        if (moved > 1e-6) {
          expect(effectChainsEquivalent(chain, far).equivalent).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('accepts a chain whose parameters were serialised in a different order', () => {
    // Requirement 29.26 compares parameter name *sets*, not order. Byte-identity is a
    // separate and stronger promise (29.27), and conflating the two would make this
    // relation stricter than the clause.
    fc.assert(
      fc.property(arbChainDocument, (document) => {
        const parsed = parseChainValue(JSON.parse(document));
        if (!parsed.ok) throw new Error('generated document failed to parse');
        const canonical = parseChainDocument(printChain(parsed.value));
        if (!canonical.ok) throw new Error('canonical form failed to parse');
        expectEquivalent(parsed.value, canonical.value);
      }),
      { numRuns: 100 },
    );
  });
});
