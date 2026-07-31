import { describe, expect, it } from 'vitest';

import { describeParseError } from '../../../domain/parse-error';
import { PACK_CUE_COUNT } from '../../../domain/sound-pack/bounds';
import { cuePackManifestsEquivalent } from '../../../domain/sound-pack/equivalence';
import type { CuePackManifest } from '../../../domain/sound-pack/manifest';
import { manifestCueNames, manifestViolations } from '../../../domain/sound-pack/manifest';
import {
  parseManifestDocument,
  parseManifestValue,
} from '../../../domain/sound-pack/manifest-parser';
import {
  manifestToDocument,
  printManifest,
  printManifestPretty,
} from '../../../domain/sound-pack/manifest-printer';
import { SEMANTIC_CUES, isLoopCue } from '../../../domain/sound-pack/taxonomy';

/**
 * `Manifest_Parser` and `Manifest_Printer` by example (Requirements 24.11–24.16).
 *
 * The round trip and its idempotence are Properties 10 and 11 and live in
 * `test/property/cue-pack-manifest.test.ts`. What is here is what a property cannot state: which
 * *specific* faults are reported, with which codes and which numbers, and where the equivalence
 * relation draws its lines.
 */

function entry(cueName: string, overrides: Record<string, unknown> = {}) {
  const cue = SEMANTIC_CUES.find((candidate) => candidate.name === cueName);
  if (cue === undefined) throw new Error(`unknown cue ${cueName}`);
  const loop = isLoopCue(cueName);
  return {
    path: `sounds/${cueName}.mp3`,
    byteSize: 4_096,
    durationMs: loop ? 1_000 : 200,
    channels: 1,
    loop,
    defaultVolume: cue.defaultVolume,
    cueName,
    categoryName: cue.category,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): CuePackManifest {
  return {
    packName: 'Soft Product',
    entries: SEMANTIC_CUES.map((cue) => entry(cue.name)),
    ...overrides,
  } as CuePackManifest;
}

describe('Manifest_Printer (Requirement 24.13)', () => {
  it('carries Requirement 24.11\'s nine facts, and the pack name once', () => {
    const document = manifestToDocument(manifest());

    expect(document.packName).toBe('Soft Product');
    expect(document.entries).toHaveLength(PACK_CUE_COUNT);
    expect(Object.keys(document.entries[0] as object)).toEqual([
      'path',
      'byteSize',
      'durationMs',
      'channels',
      'loop',
      'defaultVolume',
      'cueName',
      'categoryName',
    ]);
  });

  it('fixes key order, so two prints of the same pack are byte-identical', () => {
    expect(printManifest(manifest())).toBe(printManifest(manifest()));
    expect(printManifestPretty(manifest())).toBe(printManifestPretty(manifest()));
  });

  it('keeps entry order rather than re-sorting it', () => {
    const reversed = manifest({ entries: [...manifest().entries].reverse() });

    expect(manifestCueNames(reversed)[0]).toBe('refund');
    expect(printManifest(reversed)).not.toBe(printManifest(manifest()));
  });

  it('writes no trailing newline, and the indented form is the one the export uses', () => {
    expect(printManifest(manifest()).endsWith('}')).toBe(true);
    expect(printManifestPretty(manifest())).toContain('\n  "packName"');
  });
});

describe('Manifest_Parser (Requirements 24.12, 24.16)', () => {
  it('parses a well-formed document', () => {
    const result = parseManifestDocument(printManifest(manifest()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toHaveLength(PACK_CUE_COUNT);
    expect(cuePackManifestsEquivalent(result.value, manifest()).equivalent).toBe(true);
  });

  it('reports a syntax fault as a syntax fault, not as a shape fault', () => {
    const result = parseManifestDocument('{oops');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.violation).toBe('manifest_json_malformed');
    // The truncated input comes back so a caller can echo it.
    expect(result.errors[0]?.actual).toBe('{oops');
  });

  it('reports Requirement 24.16 with both the actual and the required count', () => {
    const result = parseManifestValue({
      packName: 'Soft',
      entries: SEMANTIC_CUES.slice(0, 77).map((cue) => entry(cue.name)),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fault = result.errors[0];
    expect(fault?.violation).toBe('manifest_entry_count_mismatch');
    expect(fault?.actual).toBe('77');
    expect(fault?.expected).toBe('78');
    // The count fault is *first*, so a caller taking `errors[0]` sees the actionable one.
    expect(describeParseError(fault as never)).toContain('manifest_entry_count_mismatch');
  });

  it('rejects a document that is not an object at all', () => {
    for (const value of [[], 'text', 7, null]) {
      const result = parseManifestValue(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.violation).toBe('manifest_not_object');
    }
  });

  it.each([
    ['path', { path: '' }, 'manifest_path_invalid'],
    ['byteSize', { byteSize: -1 }, 'manifest_byte_size_invalid'],
    ['byteSize', { byteSize: 1.5 }, 'manifest_byte_size_invalid'],
    ['durationMs', { durationMs: 0 }, 'manifest_duration_invalid'],
    ['channels', { channels: 0 }, 'manifest_channels_invalid'],
    ['loop', { loop: 'yes' }, 'manifest_loop_invalid'],
    ['defaultVolume', { defaultVolume: 1.5 }, 'manifest_default_volume_invalid'],
    ['cueName', { cueName: 'kerplunk' }, 'manifest_cue_name_unknown'],
    ['categoryName', { categoryName: 'nope' }, 'manifest_category_unknown'],
  ])('rejects a bad %s with the code %s', (_field, override, violation) => {
    const entries = SEMANTIC_CUES.map((cue, index) =>
      index === 3 ? entry(cue.name, override) : entry(cue.name),
    );

    const result = parseManifestValue({ packName: 'Soft', entries });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fault = result.errors.find((error) => error.violation === violation);
    expect(fault?.index).toBe(3);
  });

  it('rejects a loop flag that disagrees with the taxonomy', () => {
    const entries = SEMANTIC_CUES.map((cue) =>
      cue.name === 'loading' ? entry(cue.name, { loop: false, durationMs: 200 }) : entry(cue.name),
    );

    const result = parseManifestValue({ packName: 'Soft', entries });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fault = result.errors.find(
      (error) => error.violation === 'manifest_loop_disagrees_with_taxonomy',
    );
    expect(fault?.expected).toBe('true');
    expect(fault?.actual).toBe('false');
  });

  it('judges a length against the range the cue\'s own kind selects (24.4, 24.5)', () => {
    // 200 ms is a fine one-shot and far too short for a loop.
    const asLoop = parseManifestValue({
      packName: 'Soft',
      entries: SEMANTIC_CUES.map((cue) =>
        cue.name === 'loading' ? entry(cue.name, { durationMs: 200 }) : entry(cue.name),
      ),
    });
    expect(asLoop.ok).toBe(false);
    if (asLoop.ok) return;
    expect(
      asLoop.errors.some((error) => error.violation === 'manifest_loop_length_out_of_range'),
    ).toBe(true);

    const asOneShot = parseManifestValue({
      packName: 'Soft',
      entries: SEMANTIC_CUES.map((cue) =>
        cue.name === 'hover' ? entry(cue.name, { durationMs: 2_000 }) : entry(cue.name),
      ),
    });
    expect(asOneShot.ok).toBe(false);
    if (asOneShot.ok) return;
    expect(
      asOneShot.errors.some(
        (error) => error.violation === 'manifest_one_shot_length_out_of_range',
      ),
    ).toBe(true);
  });

  it('returns every fault rather than the first, unlike Chain_Parser', () => {
    const entries = SEMANTIC_CUES.map((cue) => entry(cue.name, { channels: 0 }));

    const result = parseManifestValue({ packName: 'Soft', entries });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Requirement 24.16 imposes no "first only" limit, and 78 round trips to fix 78 entries is
    // the outcome that limit would produce.
    expect(result.errors.length).toBe(PACK_CUE_COUNT);
  });

  it('drops keys the contract does not name, so noise cannot break byte-identity', () => {
    const entries = SEMANTIC_CUES.map((cue) => entry(cue.name, { extra: 'noise' }));

    const result = parseManifestValue({ packName: 'Soft', entries, alsoNoise: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.entries[0] as object)).not.toContain('extra');
    expect(printManifest(result.value)).toBe(printManifest(manifest({ packName: 'Soft' })));
  });

  it('reports the pack name bound of Requirement 24.1', () => {
    const result = parseManifestValue({ packName: '', entries: manifest().entries });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.violation).toBe('manifest_pack_name_invalid');
    expect(result.errors[0]?.field).toBe('packName');
  });

  it('reports a non-array entries field before looking inside it', () => {
    expect(manifestViolations({ packName: 'Soft', entries: 'nope' })).toEqual([
      {
        field: 'entries',
        violation: 'manifest_entries_not_array',
        expected: 'an array of 78 cue entries',
        actual: 'nope',
      },
    ]);
  });
});

describe('the manifest equivalence relation (design §7.1)', () => {
  it('is reflexive, and blind to nothing the contract names', () => {
    expect(cuePackManifestsEquivalent(manifest(), manifest()).equivalent).toBe(true);
  });

  it('separates a different pack name, and says which', () => {
    const verdict = cuePackManifestsEquivalent(manifest(), manifest({ packName: 'Other' }));

    expect(verdict.equivalent).toBe(false);
    if (verdict.equivalent) return;
    expect(verdict.reason).toContain('packName');
  });

  it('separates a permuted entry list, because order is part of the relation', () => {
    const verdict = cuePackManifestsEquivalent(
      manifest(),
      manifest({ entries: [...manifest().entries].reverse() }),
    );

    expect(verdict.equivalent).toBe(false);
  });

  it('separates a different entry count, and names both', () => {
    const verdict = cuePackManifestsEquivalent(
      manifest(),
      manifest({ entries: manifest().entries.slice(0, 10) }),
    );

    expect(verdict.equivalent).toBe(false);
    if (verdict.equivalent) return;
    expect(verdict.reason).toContain('78');
    expect(verdict.reason).toContain('10');
  });

  it('treats −0 and 0 as the same level, which is what a round trip produces', () => {
    const withNegativeZero = manifest({
      entries: SEMANTIC_CUES.map((cue, index) =>
        index === 0 ? entry(cue.name, { defaultVolume: -0 }) : entry(cue.name),
      ),
    });
    const withPositiveZero = manifest({
      entries: SEMANTIC_CUES.map((cue, index) =>
        index === 0 ? entry(cue.name, { defaultVolume: 0 }) : entry(cue.name),
      ),
    });

    // `Object.is(-0, 0)` is false, and asserting with it here is exactly the spurious failure
    // task 3.2 hit on the Effect_Chain round trip.
    expect(Object.is(-0, 0)).toBe(false);
    expect(cuePackManifestsEquivalent(withNegativeZero, withPositiveZero).equivalent).toBe(true);
  });

  it('reports a NaN drift rather than accepting it', () => {
    const withNaN = manifest({
      entries: SEMANTIC_CUES.map((cue, index) =>
        index === 0 ? entry(cue.name, { durationMs: Number.NaN }) : entry(cue.name),
      ),
    });

    const verdict = cuePackManifestsEquivalent(withNaN, manifest());

    expect(verdict.equivalent).toBe(false);
    if (verdict.equivalent) return;
    expect(verdict.reason).toContain('durationMs');
  });

  it('names the offending entry by index and cue name', () => {
    const verdict = cuePackManifestsEquivalent(
      manifest(),
      manifest({
        entries: SEMANTIC_CUES.map((cue, index) =>
          index === 5 ? entry(cue.name, { byteSize: 9 }) : entry(cue.name),
        ),
      }),
    );

    expect(verdict.equivalent).toBe(false);
    if (verdict.equivalent) return;
    expect(verdict.reason).toContain('entry 5');
    expect(verdict.reason).toContain(SEMANTIC_CUES[5]?.name as string);
  });
});
