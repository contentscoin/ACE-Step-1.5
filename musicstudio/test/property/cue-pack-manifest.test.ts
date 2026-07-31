import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CUE_DEFAULT_VOLUME_MAX,
  CUE_DEFAULT_VOLUME_MIN,
  LOOP_LENGTH_SECONDS_MAX,
  LOOP_LENGTH_SECONDS_MIN,
  ONE_SHOT_LENGTH_SECONDS_MAX,
  ONE_SHOT_LENGTH_SECONDS_MIN,
  PACK_CUE_COUNT,
  PACK_NAME_MAX_LENGTH,
  PACK_NAME_MIN_LENGTH,
} from '../../domain/sound-pack/bounds';
import {
  MANIFEST_NUMERIC_TOLERANCE,
  cuePackManifestsEquivalent,
} from '../../domain/sound-pack/equivalence';
import type { CueManifestEntry, CuePackManifest } from '../../domain/sound-pack/manifest';
import { parseManifestDocument } from '../../domain/sound-pack/manifest-parser';
import { printManifest, printManifestPretty } from '../../domain/sound-pack/manifest-printer';
import { SEMANTIC_CUES, isLoopCue } from '../../domain/sound-pack/taxonomy';

/**
 * Properties 10 and 11 of design §10 — the `Cue_Pack_Manifest` round trip and its idempotence.
 *
 * Task 3.4 owns these two and only these two (tasks.md §9.2's ownership table). Anything else
 * asserted here is labelled **unnumbered** so task 9.2's audit does not miscount it, following
 * the convention `dsp/test/test_mfcc.py` uses on the Python side.
 *
 * ### The generator is not `fc.record` over arbitrary values
 *
 * A manifest is only *valid* when its 78 entries are the taxonomy's 78 cues, in order, each with
 * a loop flag matching its category and a length inside the range that flag selects — see
 * `domain/sound-pack/manifest.ts`. Properties 10 and 11 are both quantified over *valid*
 * structures (24.14: "유효한 Cue_Pack_Manifest 구조체"; 24.15: "파싱에 성공한 … 파일"), so a
 * generator that produced arbitrary cue names would spend every run on inputs the properties say
 * nothing about. `validManifest` therefore fixes the cue names and categories and varies exactly
 * what a real export varies: the pack name, and per cue the path, byte size, duration, channel
 * count and default volume.
 *
 * That is the "smart generator" discipline: constrain to the input space, then vary everything
 * inside it. The rejection the loose generator would need is not merely slow — with 78 entries
 * each needing a taxonomy name, a random draw essentially never succeeds.
 */

/** A path a real export writes: `sounds/<cue>.mp3`, with the extension varied. */
function pathArbitrary(cueName: string): fc.Arbitrary<string> {
  return fc
    .constantFrom('mp3', 'ogg')
    .map((extension) => `sounds/${cueName}.${extension}`);
}

/** Milliseconds inside the range Requirement 24.4 or 24.5 allows for this cue. */
function durationArbitrary(loop: boolean): fc.Arbitrary<number> {
  const min = (loop ? LOOP_LENGTH_SECONDS_MIN : ONE_SHOT_LENGTH_SECONDS_MIN) * 1000;
  const max = (loop ? LOOP_LENGTH_SECONDS_MAX : ONE_SHOT_LENGTH_SECONDS_MAX) * 1000;
  // `noNaN` and a closed interval, because a duration outside the range makes the structure
  // invalid and the properties are quantified over valid ones.
  return fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
}

function entryArbitrary(cueName: string): fc.Arbitrary<CueManifestEntry> {
  const cue = SEMANTIC_CUES.find((candidate) => candidate.name === cueName);
  if (cue === undefined) throw new Error(`unknown cue ${cueName}`);
  const loop = isLoopCue(cueName);

  return fc.record({
    path: pathArbitrary(cueName),
    byteSize: fc.nat({ max: 5_000_000 }),
    durationMs: durationArbitrary(loop),
    channels: fc.integer({ min: 1, max: 2 }),
    loop: fc.constant(loop),
    defaultVolume: fc.double({
      min: CUE_DEFAULT_VOLUME_MIN,
      max: CUE_DEFAULT_VOLUME_MAX,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    cueName: fc.constant(cueName),
    categoryName: fc.constant(cue.category),
  });
}

/** A valid `Cue_Pack_Manifest`: 78 entries, the taxonomy's names, in taxonomy order. */
function validManifest(): fc.Arbitrary<CuePackManifest> {
  return fc.record({
    packName: fc.string({ minLength: PACK_NAME_MIN_LENGTH, maxLength: PACK_NAME_MAX_LENGTH }),
    entries: fc.tuple(...SEMANTIC_CUES.map((cue) => entryArbitrary(cue.name))),
  });
}

describe('Feature: ai-music-generation-service, Property 10: Cue_Pack_Manifest round-trip', () => {
  /**
   * Feature: ai-music-generation-service, Property 10: For any valid `Cue_Pack_Manifest`
   * structure, printing it and re-parsing the result yields a structure equivalent to the
   * original.
   *
   * **Validates: Requirements 24.14**
   */
  it('prints and re-parses to an equivalent structure', async () => {
    await fc.assert(
      fc.asyncProperty(validManifest(), async (manifest) => {
        const document = printManifest(manifest);
        const reparsed = parseManifestDocument(document);

        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;

        const verdict = cuePackManifestsEquivalent(manifest, reparsed.value);
        // The reason is asserted on, not just the boolean: a failure that says only `false`
        // costs a debugging session.
        expect(verdict.equivalent, 'reason' in verdict ? verdict.reason : '').toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * The same property against the indented document, which is the form the export writes.
   *
   * Unnumbered — it is the same Property 10 over the other printer, kept because the two printers
   * are separate functions and a change to one must not silently break the round trip of the one
   * that actually lands in the archive.
   */
  it('round-trips the indented document the export writes', async () => {
    await fc.assert(
      fc.asyncProperty(validManifest(), async (manifest) => {
        const reparsed = parseManifestDocument(printManifestPretty(manifest));
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;
        expect(cuePackManifestsEquivalent(manifest, reparsed.value).equivalent).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: ai-music-generation-service, Property 11: Cue_Pack_Manifest idempotence', () => {
  /**
   * Feature: ai-music-generation-service, Property 11: For any Cue_Pack_Manifest file that parses
   * successfully, parsing then printing then re-parsing yields a structure equivalent to the first
   * parse, and the two printed documents are byte-identical.
   *
   * **Validates: Requirements 24.15**
   */
  it('parse → print → parse equals the first parse, and the documents are byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(validManifest(), async (manifest) => {
        // The *file* is the subject of 24.15, so the property starts from a document rather than
        // from a structure — which is what makes it a different claim from Property 10.
        const first = parseManifestDocument(printManifest(manifest));
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const printedOnce = printManifest(first.value);
        const second = parseManifestDocument(printedOnce);
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        const printedTwice = printManifest(second.value);

        const verdict = cuePackManifestsEquivalent(first.value, second.value);
        expect(verdict.equivalent, 'reason' in verdict ? verdict.reason : '').toBe(true);
        // Byte-identity, which is stronger than equivalence and is what a stored document needs.
        expect(printedTwice).toBe(printedOnce);
      }),
      { numRuns: 200 },
    );
  });
});

describe('unnumbered manifest invariants', () => {
  /**
   * Unnumbered. Design §10 numbers no property for key order, but Requirement 24.15's
   * byte-identity depends on it entirely: the printer must not inherit the insertion order of the
   * object it was handed.
   */
  it('prints the same bytes for a manifest whose keys were built in another order', async () => {
    await fc.assert(
      fc.asyncProperty(validManifest(), async (manifest) => {
        const shuffled: CuePackManifest = {
          entries: manifest.entries.map((entry) => ({
            // Deliberately the reverse of `CUE_MANIFEST_ENTRY_FIELDS` order.
            categoryName: entry.categoryName,
            cueName: entry.cueName,
            defaultVolume: entry.defaultVolume,
            loop: entry.loop,
            channels: entry.channels,
            durationMs: entry.durationMs,
            byteSize: entry.byteSize,
            path: entry.path,
          })),
          packName: manifest.packName,
        };

        expect(printManifest(shuffled)).toBe(printManifest(manifest));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Unnumbered. The tolerance in the equivalence relation is zero by default, so this pins that
   * the round trip really is exact rather than merely within a tolerance — which is the claim
   * design §7.1's "필드 값 일치" makes.
   */
  it('loses no precision in any numeric field', async () => {
    await fc.assert(
      fc.asyncProperty(validManifest(), async (manifest) => {
        const reparsed = parseManifestDocument(printManifest(manifest));
        if (!reparsed.ok) throw new Error('valid manifest failed to parse');

        for (const [index, entry] of manifest.entries.entries()) {
          const other = reparsed.value.entries[index];
          // Absolute difference, never `toBe` or `Object.is`: `JSON.stringify(-0)` is `"0"`, so a
          // `-0` default volume comes back as `+0` and an identity comparison would fail for two
          // numbers that denote the same level. See `domain/sound-pack/equivalence.ts`.
          expect(Math.abs(entry.durationMs - (other?.durationMs ?? NaN))).toBeLessThanOrEqual(
            MANIFEST_NUMERIC_TOLERANCE,
          );
          expect(Math.abs(entry.defaultVolume - (other?.defaultVolume ?? NaN))).toBeLessThanOrEqual(
            MANIFEST_NUMERIC_TOLERANCE,
          );
          expect(entry.byteSize).toBe(other?.byteSize);
        }
      }),
      { numRuns: 100 },
    );
  });

  /** Unnumbered. Requirement 24.16's count, as a property over the wrong counts. */
  it('rejects any entry count other than 78, reporting both numbers', async () => {
    await fc.assert(
      fc.asyncProperty(
        validManifest(),
        fc.integer({ min: 0, max: PACK_CUE_COUNT - 1 }),
        async (manifest, keep) => {
          const truncated = { ...manifest, entries: manifest.entries.slice(0, keep) };
          const result = parseManifestDocument(printManifest(truncated));

          expect(result.ok).toBe(false);
          if (result.ok) return;
          const countFault = result.errors.find(
            (error) => error.violation === 'manifest_entry_count_mismatch',
          );
          expect(countFault?.expected).toBe(String(PACK_CUE_COUNT));
          expect(countFault?.actual).toBe(String(keep));
        },
      ),
      { numRuns: 100 },
    );
  });
});
