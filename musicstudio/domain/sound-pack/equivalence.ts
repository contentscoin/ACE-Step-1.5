/**
 * The **manifest equivalence relation** (design §7.1, Requirements 24.14, 24.15).
 *
 * §7.1's row for `Cue_Pack_Manifest` states the relation in three words — **필드 값 일치**,
 * field values equal — which is the strictest of the five and the easiest to get subtly
 * wrong. Two decisions make it right rather than merely strict:
 *
 * **1. Numbers are compared by absolute difference, not by `===` or `Object.is`.**
 * A manifest round-trips through decimal JSON, and `JSON.stringify` emits the shortest
 * representation that round-trips a double exactly — so for every finite value the
 * difference really is zero and the tolerance is never *needed*. It is here for one case
 * that is not hypothetical and that task 3.2 hit on the `Effect_Chain` round trip:
 * `JSON.stringify(-0)` is `"0"`, so a `-0` anywhere in the structure comes back as `+0`.
 * `Object.is(-0, 0)` is false and `-0 === 0` is true, so an `Object.is` comparison would
 * fail Property 10 for a pair of numbers that denote the same quantity, while `===` would
 * pass but would also silently accept `NaN !== NaN` as a difference it cannot report.
 * `Math.abs(left - right) <= tolerance` written as `!(drift <= tolerance)` reports `NaN`
 * and treats `-0` and `0` as equal, which is both of those problems solved by the same
 * line.
 *
 * The tolerance is therefore **exactly zero** by default. It is a parameter so a caller
 * comparing a manifest against one that came back through a system that rounds (a database
 * with a `numeric(10,3)` column, say) can say so explicitly, rather than this relation
 * being loosened for everybody to accommodate a caller that does not exist yet.
 *
 * **2. Entry order is part of the relation.** Entries are compared index by index, not as
 * sets keyed by cue name. §7.1 says field values match, and the printer preserves order
 * (see `manifest-printer.ts`), so a manifest whose entries were permuted prints
 * differently and is a different document. Comparing as a set would make Property 10 pass
 * for a printer that lost the ordering — which is precisely the regression the property
 * exists to catch.
 *
 * Every mismatch returns a reason, following `domain/effects/equivalence.ts`. A property
 * failure that says only `false` costs a debugging session; one that says
 * `entry 41 (loading) byteSize drifted 12` does not.
 */

import { CUE_MANIFEST_ENTRY_FIELDS, type CueManifestEntry, type CuePackManifest } from './manifest';

/** Design §7.1's relation is exact field equality, so the default tolerance is 0. */
export const MANIFEST_NUMERIC_TOLERANCE = 0;

export type ManifestEquivalenceVerdict =
  | { readonly equivalent: true }
  | { readonly equivalent: false; readonly reason: string };

const EQUIVALENT: ManifestEquivalenceVerdict = { equivalent: true };

function differs(reason: string): ManifestEquivalenceVerdict {
  return { equivalent: false, reason };
}

/** Which entry fields hold numbers, so the tolerance applies to exactly those. */
const NUMERIC_FIELDS = ['byteSize', 'durationMs', 'channels', 'defaultVolume'] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];

export function cuePackManifestsEquivalent(
  left: CuePackManifest,
  right: CuePackManifest,
  tolerance: number = MANIFEST_NUMERIC_TOLERANCE,
): ManifestEquivalenceVerdict {
  if (left.packName !== right.packName) {
    return differs(`packName ${left.packName} !== ${right.packName}`);
  }

  if (left.entries.length !== right.entries.length) {
    return differs(
      `entry count ${String(left.entries.length)} !== ${String(right.entries.length)}`,
    );
  }

  for (const [index, leftEntry] of left.entries.entries()) {
    const rightEntry = right.entries[index];
    if (rightEntry === undefined) return differs(`entry ${String(index)} missing`);

    const verdict = entriesEquivalent(leftEntry, rightEntry, index, tolerance);
    if (!verdict.equivalent) return verdict;
  }

  return EQUIVALENT;
}

function entriesEquivalent(
  left: CueManifestEntry,
  right: CueManifestEntry,
  index: number,
  tolerance: number,
): ManifestEquivalenceVerdict {
  const where = `entry ${String(index)} (${left.cueName})`;

  // Iterated over the field list rather than written out, so a tenth field added to
  // `CueManifestEntry` without being added to this comparison is a type error rather than a
  // field the relation silently stops looking at.
  for (const field of CUE_MANIFEST_ENTRY_FIELDS) {
    if ((NUMERIC_FIELDS as readonly string[]).includes(field)) {
      const leftValue = left[field as NumericField];
      const rightValue = right[field as NumericField];
      const drift = Math.abs(leftValue - rightValue);
      // `!(drift <= tolerance)` rather than `drift > tolerance`, so a `NaN` drift — which
      // compares false against everything — is reported rather than accepted.
      if (!(drift <= tolerance)) {
        return differs(
          `${where} ${field} drifted ${String(drift)} (> ${String(tolerance)}): ` +
            `${String(leftValue)} vs ${String(rightValue)}`,
        );
      }
      continue;
    }

    const leftValue = left[field];
    const rightValue = right[field];
    if (leftValue !== rightValue) {
      return differs(`${where} ${field} ${String(leftValue)} !== ${String(rightValue)}`);
    }
  }

  return EQUIVALENT;
}

/** Convenience for the call sites that only need the boolean. */
export function manifestsEquivalent(left: CuePackManifest, right: CuePackManifest): boolean {
  return cuePackManifestsEquivalent(left, right).equivalent;
}
