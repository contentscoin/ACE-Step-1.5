/**
 * `Cue_Pack_Manifest` — the structure Requirement 24.11 puts inside an export.
 *
 * 24.11 lists exactly nine facts per cue: file path, byte size, audio length, channel
 * count, loop flag, default volume, cue name, category name, pack name. Eight of them
 * vary per cue and the ninth (the pack name) does not, so the structure is a pack header
 * plus 78 entries rather than 78 copies of the pack name — which also makes 24.16's
 * "entry count is not 78" a check on one array rather than a consistency check between
 * 78 repeated strings.
 *
 * ### Why the violation list is here and not in the parser
 *
 * Same arrangement as `domain/effects/chain.ts` and `chain-parser.ts`, for the same
 * reason. Requirement 24.16 constrains what the *parser* returns (the entry count and the
 * required count), but a manifest can also arrive as already-decoded data — from a
 * `jsonb` read, or assembled by the export path from the worker's file report — and those
 * routes need the same rules without a serialise/reparse round trip that could fail for
 * reasons the input never had. So `manifestViolations` is the rule set, `toManifest` is
 * the narrowing, and `manifest-parser.ts` is the document-shaped door onto both.
 *
 * ### What is validated, and what deliberately is not
 *
 * Validated: the nine fields' presence and types, the entry count (24.16), that the cue
 * names are the taxonomy's 78 (24.2), that the loop flag agrees with the taxonomy (24.5),
 * that the default volume is in `[0, 1]` (24.11 via design §8.3), and that the audio
 * length is inside the range its kind allows (24.4, 24.5).
 *
 * **Not** validated: loudness (24.7), seam continuity (24.6), tail decay (24.8) and
 * cue-pair similarity (24.9). Those are claims about *samples*, and a manifest holds no
 * samples — a parser that accepted or rejected a manifest on their basis would be
 * asserting something it cannot observe. They are the Sound_Pack_Service's judgements,
 * made against measurements, and they are why a pack has a status (`status.ts`) that a
 * manifest does not carry.
 *
 * ### Numbers are stored, not recomputed
 *
 * `byteSize` and `durationMs` come from the export that produced the files and are
 * carried verbatim. Recomputing either from the audio here would make the manifest a
 * second opinion about the archive rather than a description of it, and a consumer
 * unzipping the archive checks the manifest against the *files*, which is the comparison
 * worth being able to fail.
 */

import {
  CUE_DEFAULT_VOLUME_MAX,
  CUE_DEFAULT_VOLUME_MIN,
  PACK_CUE_COUNT,
  cueLengthRangeSeconds,
  isCueDefaultVolume,
  isPackName,
} from './bounds';
import { CUE_NAMES, isCueCategory, isLoopCue, type CueCategory } from './taxonomy';

/** Requirement 24.11's nine facts, for one cue. */
export interface CueManifestEntry {
  /** Archive-relative path of the audio file. */
  readonly path: string;
  /** Size of that file, in bytes, as written. */
  readonly byteSize: number;
  /** Audio length in milliseconds. */
  readonly durationMs: number;
  readonly channels: number;
  /** Requirement 24.5: whether this cue is a loop asset. */
  readonly loop: boolean;
  /** Requirement 24.11's 기본 음량, in `[0, 1]`. */
  readonly defaultVolume: number;
  readonly cueName: string;
  readonly categoryName: CueCategory;
}

export interface CuePackManifest {
  /** Requirement 24.11's 팩 이름, once rather than 78 times. */
  readonly packName: string;
  /** Requirement 24.16: exactly `PACK_CUE_COUNT` entries, in taxonomy order. */
  readonly entries: readonly CueManifestEntry[];
}

/**
 * A single fault, in the vocabulary design §7.2's `ParseError` carries.
 *
 * `index` is the entry's position, absent for a fault about the manifest as a whole.
 * `violation` is a stable code rather than a sentence, for the reason
 * `domain/parse-error.ts` gives.
 */
export interface ManifestViolation {
  readonly index?: number;
  readonly field?: string;
  readonly violation: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** Fields of an entry, in the order they are printed. */
export const CUE_MANIFEST_ENTRY_FIELDS = [
  'path',
  'byteSize',
  'durationMs',
  'channels',
  'loop',
  'defaultVolume',
  'cueName',
  'categoryName',
] as const;

/**
 * Every fault in a candidate manifest, in a fixed order.
 *
 * The order is manifest-level faults first, then entries in index order, then the fields
 * of each entry in `CUE_MANIFEST_ENTRY_FIELDS` order. Fixed rather than incidental,
 * because Requirement 24.16 and design §7.2 both make the parser report the *first*
 * violation, and "first" is only meaningful against one ordering defined in one place.
 */
export function manifestViolations(value: unknown): readonly ManifestViolation[] {
  const violations: ManifestViolation[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [
      {
        violation: 'manifest_not_object',
        expected: 'a JSON object with packName and entries',
        actual: describe(value),
      },
    ];
  }

  const record = value as Record<string, unknown>;

  if (!isPackName(record['packName'])) {
    violations.push({
      field: 'packName',
      violation: 'manifest_pack_name_invalid',
      expected: '1–60 characters',
      actual: describe(record['packName']),
    });
  }

  const entries = record['entries'];
  if (!Array.isArray(entries)) {
    violations.push({
      field: 'entries',
      violation: 'manifest_entries_not_array',
      expected: `an array of ${String(PACK_CUE_COUNT)} cue entries`,
      actual: describe(entries),
    });
    return violations;
  }

  // Requirement 24.16, stated before the per-entry rules so that a manifest of the wrong
  // size reports its size rather than 78 field faults the caller cannot act on.
  if (entries.length !== PACK_CUE_COUNT) {
    violations.push({
      field: 'entries',
      violation: 'manifest_entry_count_mismatch',
      expected: String(PACK_CUE_COUNT),
      actual: String(entries.length),
    });
  }

  for (const [index, entry] of entries.entries()) {
    violations.push(...entryViolations(entry, index));
  }

  return violations;
}

function entryViolations(entry: unknown, index: number): readonly ManifestViolation[] {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [
      {
        index,
        violation: 'manifest_entry_not_object',
        expected: 'a JSON object',
        actual: describe(entry),
      },
    ];
  }

  const record = entry as Record<string, unknown>;
  const violations: ManifestViolation[] = [];
  const fault = (field: string, violation: string, expected: string): void => {
    violations.push({ index, field, violation, expected, actual: describe(record[field]) });
  };

  if (typeof record['path'] !== 'string' || record['path'].length === 0) {
    fault('path', 'manifest_path_invalid', 'a non-empty archive-relative path');
  }
  if (!isNonNegativeInteger(record['byteSize'])) {
    fault('byteSize', 'manifest_byte_size_invalid', 'a non-negative integer');
  }
  if (!isFinitePositive(record['durationMs'])) {
    fault('durationMs', 'manifest_duration_invalid', 'a positive number of milliseconds');
  }
  if (!isPositiveInteger(record['channels'])) {
    fault('channels', 'manifest_channels_invalid', 'a positive integer');
  }
  if (typeof record['loop'] !== 'boolean') {
    fault('loop', 'manifest_loop_invalid', 'a boolean');
  }
  if (!isCueDefaultVolume(record['defaultVolume'])) {
    fault(
      'defaultVolume',
      'manifest_default_volume_invalid',
      `${String(CUE_DEFAULT_VOLUME_MIN)}–${String(CUE_DEFAULT_VOLUME_MAX)}`,
    );
  }

  const cueName = record['cueName'];
  const known = typeof cueName === 'string' && CUE_NAMES.includes(cueName);
  if (!known) {
    // Requirement 24.2's name set. An unknown cue name is reported as such rather than as
    // a missing-cue error, because 24.3's missing-cue list is a claim about the *pack* and
    // is assembled by `missingCueNames`; a manifest entry can only be wrong about itself.
    fault('cueName', 'manifest_cue_name_unknown', 'a Semantic_Cue taxonomy name');
  }

  if (!isCueCategory(record['categoryName'])) {
    fault('categoryName', 'manifest_category_unknown', 'a Semantic_Cue category name');
  }

  // The two cross-field rules. Both need `cueName` to be known first, which is why they
  // are guarded rather than merged into the field loop above: a rule that compared an
  // unknown cue's loop flag against the taxonomy would report a second fault for one cause.
  if (known) {
    const name = cueName as string;
    const expectedLoop = isLoopCue(name);
    if (record['loop'] === !expectedLoop) {
      violations.push({
        index,
        field: 'loop',
        violation: 'manifest_loop_disagrees_with_taxonomy',
        expected: String(expectedLoop),
        actual: String(record['loop']),
      });
    }

    if (isFinitePositive(record['durationMs'])) {
      const range = cueLengthRangeSeconds(expectedLoop);
      const seconds = (record['durationMs'] as number) / 1000;
      if (seconds < range.min || seconds > range.max) {
        violations.push({
          index,
          field: 'durationMs',
          violation: expectedLoop
            ? 'manifest_loop_length_out_of_range'
            : 'manifest_one_shot_length_out_of_range',
          expected: `${String(range.min * 1000)}–${String(range.max * 1000)} ms`,
          actual: String(record['durationMs']),
        });
      }
    }
  }

  return violations;
}

/**
 * The manifest a value denotes. Only call this on a value with no violations.
 *
 * Narrowing rather than parsing: every field has already been checked, so this reads them
 * and drops anything else the document carried. Dropping unknown keys is deliberate — the
 * manifest is a published contract with a fixed field list (24.11), and preserving extra
 * keys would make two manifests that differ only in noise print differently and so break
 * the byte-identity half of Requirement 24.15.
 */
export function toManifest(value: unknown): CuePackManifest {
  const record = value as { packName: string; entries: readonly Record<string, unknown>[] };
  return {
    packName: record.packName,
    entries: record.entries.map((entry) => ({
      path: entry['path'] as string,
      byteSize: entry['byteSize'] as number,
      durationMs: entry['durationMs'] as number,
      channels: entry['channels'] as number,
      loop: entry['loop'] as boolean,
      defaultVolume: entry['defaultVolume'] as number,
      cueName: entry['cueName'] as string,
      categoryName: entry['categoryName'] as CueCategory,
    })),
  };
}

/** The cue names a manifest carries, in entry order. Requirement 24.2's subject. */
export function manifestCueNames(manifest: CuePackManifest): readonly string[] {
  return manifest.entries.map((entry) => entry.cueName);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0;
}

function isFinitePositive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** A short, printable rendering of any input, for `actual`. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  return typeof value;
}
