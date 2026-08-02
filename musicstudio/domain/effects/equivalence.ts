/**
 * The **chain equivalence relation** (design §7.1, Requirement 29.26).
 *
 * Requirement 29.26 defines it in one sentence, and all four clauses matter:
 *
 * > 이펙트 항목 개수가 같고, 동일 인덱스의 이펙트 종류 이름이 문자 단위로 같고,
 * > 동일 인덱스의 파라미터 이름 집합이 같으며, 대응하는 모든 수치 파라미터 값의
 * > 절대 차이가 0.000001 이하인 상태
 *
 * So: equal item count, character-identical kind names at equal indexes, equal
 * parameter *name sets* at equal indexes, and every corresponding numeric value within
 * 1e-6 absolute.
 *
 * This is written as a function, following `domain/lyrics/equivalence.ts`, for the two
 * reasons that module gives. Deep equality is the **wrong** relation here — it would
 * demand exact floating-point equality and so contradict 29.26's explicit tolerance,
 * which exists precisely because a chain round-trips through decimal JSON. And it is
 * also **too strict** in the other direction: a future derived field on `EffectItem`
 * (a cached display label, a UI colour) would break Properties 8 and 9 for a reason
 * Requirement 29 does not care about.
 *
 * Note what the relation deliberately does *not* say: nothing about parameter *order*.
 * It compares name **sets**, so a chain whose parameters were listed differently is
 * still equivalent. Byte-identical reprinting is a separate and stronger promise made
 * by Requirement 29.27, and `chain.ts` keeps it structurally by fixing parameter order
 * on entry. Conflating the two would make this relation stricter than the requirement.
 *
 * Every mismatch returns a reason. A property failure that says only `false` costs a
 * debugging session; one that says `item 2 parameter mix: 0.5 vs 0.7` does not.
 */

import type { EffectChain } from './chain';
import { CHAIN_PARAMETER_TOLERANCE } from './registry';

export type ChainEquivalenceVerdict =
  | { readonly equivalent: true }
  | { readonly equivalent: false; readonly reason: string };

const EQUIVALENT: ChainEquivalenceVerdict = { equivalent: true };

function differs(reason: string): ChainEquivalenceVerdict {
  return { equivalent: false, reason };
}

export function effectChainsEquivalent(
  left: EffectChain,
  right: EffectChain,
  tolerance: number = CHAIN_PARAMETER_TOLERANCE,
): ChainEquivalenceVerdict {
  // Clause 1: item count.
  if (left.items.length !== right.items.length) {
    return differs(
      `item count ${String(left.items.length)} !== ${String(right.items.length)}`,
    );
  }

  for (const [index, leftItem] of left.items.entries()) {
    const rightItem = right.items[index];
    if (rightItem === undefined) return differs(`item ${String(index)} missing`);

    // Clause 2: kind name, character for character. Not case-insensitive and not
    // normalised — the kind vocabulary is a closed set of ASCII identifiers, so any
    // difference at all is a different effect.
    if (leftItem.kind !== rightItem.kind) {
      return differs(`item ${String(index)} kind ${leftItem.kind} !== ${rightItem.kind}`);
    }

    // Clause 3: parameter name *sets*. Compared as sets, in both directions, because a
    // one-directional check would call `{a, b}` equivalent to `{a}`.
    const leftNames = Object.keys(leftItem.parameters);
    const rightNames = Object.keys(rightItem.parameters);
    if (leftNames.length !== rightNames.length) {
      return differs(
        `item ${String(index)} parameter count ${String(leftNames.length)} !== ${String(rightNames.length)}`,
      );
    }
    for (const name of leftNames) {
      if (!Object.hasOwn(rightItem.parameters, name)) {
        return differs(`item ${String(index)} parameter ${name} missing on the right`);
      }
    }

    // Clause 4: every corresponding value within the tolerance, inclusive ("이하").
    for (const name of leftNames) {
      const leftValue = leftItem.parameters[name] as number;
      const rightValue = rightItem.parameters[name] as number;
      const drift = Math.abs(leftValue - rightValue);
      if (!(drift <= tolerance)) {
        // Written `!(drift <= t)` rather than `drift > t` so that a `NaN` drift — which
        // compares false against everything — is reported rather than accepted.
        return differs(
          `item ${String(index)} parameter ${name} drifted ${String(drift)} (> ${String(tolerance)})`,
        );
      }
    }
  }

  return EQUIVALENT;
}

/** Convenience for the many call sites that only need the boolean. */
export function chainsEquivalent(left: EffectChain, right: EffectChain): boolean {
  return effectChainsEquivalent(left, right).equivalent;
}
