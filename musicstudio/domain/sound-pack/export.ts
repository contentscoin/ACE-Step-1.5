/**
 * Requirements 24.10 and 24.11: what a correct export looks like, as a pure judgement.
 *
 * 24.10 asks for four things at once and they are worth separating, because three of them
 * are structural and one is a stopwatch:
 *
 * 1. **156 audio files** — one mp3 and one ogg per cue (`PACK_EXPORT_FILE_COUNT`).
 * 2. **48 000 Hz** for every one of them.
 * 3. **A single compressed file** holding them, with the manifest inside it (24.11).
 * 4. **Within 60 seconds.**
 *
 * ### How the 60-second budget is tested without waiting 60 seconds
 *
 * The judgement is separated from the work. The DSP worker performs the export and
 * *measures* its own wall time (`export_pack` in `dsp/src/musicstudio_dsp/sound_pack.py`
 * returns `elapsed_ms`); this module decides whether an elapsed time is acceptable. So the
 * predicate is a pure function of a number and is tested by example at 0 ms, at the budget
 * exactly, and one millisecond past it — no test sleeps, and none has to produce a slow
 * export to exercise the failure branch. The Python side separately exports a real 78-cue
 * pack and asserts the measured time lands far inside the budget, which is the other half
 * of the evidence: the predicate is right about numbers, and the numbers are small.
 *
 * That split is also why the budget is a Quality_Threshold_Set member. It is read through
 * `packExportThresholds`, so an operator who raises it (Requirement 34.4) changes the
 * verdict without a deploy, and the version that produced a verdict is recorded with it
 * (34.6).
 *
 * The budget is **inclusive** — "60초 이내" — so an export measured at exactly 60 000 ms
 * passes. The boundary matters more here than for most thresholds: a budget that is
 * routinely brushed is exactly the case where an off-by-one turns an operational
 * observation into a spurious failure.
 *
 * ### What the file-count check is really guarding
 *
 * Not arithmetic. It is guarding against a pack exported from an *incomplete* set of cues:
 * 77 cues produce 154 files, which is a perfectly well-formed archive that satisfies every
 * other clause and is missing a sound. So the check is stated against
 * `PACK_EXPORT_FILE_COUNT` rather than against `2 × cues.length`, which would be true of
 * any input and would therefore never fail.
 */

import type { PackExportThresholds } from '../quality/sound-pack-thresholds';

import {
  PACK_EXPORT_FILE_COUNT,
  PACK_EXPORT_FORMATS,
  PACK_EXPORT_SAMPLE_RATE,
  type PackExportFormat,
} from './bounds';

/** One file the export wrote. Requirement 24.11's per-file facts. */
export interface ExportedCueFile {
  readonly cueName: string;
  readonly format: PackExportFormat;
  readonly path: string;
  readonly byteSize: number;
  readonly durationMs: number;
  readonly channels: number;
  readonly sampleRate: number;
}

/** What the export produced, as reported by whatever performed it. */
export interface PackExportReport {
  readonly files: readonly ExportedCueFile[];
  /** Wall time of the whole export, measured by the exporter. */
  readonly elapsedMs: number;
  /** Path of the manifest inside the archive (Requirement 24.11). */
  readonly manifestEntry: string;
  readonly archiveByteSize: number;
}

/** The ways an export can fail Requirement 24.10 or 24.11. */
export const PACK_EXPORT_FAULTS = [
  'file_count_mismatch',
  'format_coverage_incomplete',
  'sample_rate_wrong',
  'manifest_missing',
  'archive_empty',
  'budget_exceeded',
] as const;

export type PackExportFault = (typeof PACK_EXPORT_FAULTS)[number];

export const PACK_EXPORT_FAULT_REQUIREMENT: Readonly<Record<PackExportFault, string>> = {
  file_count_mismatch: '24.10',
  format_coverage_incomplete: '24.10',
  sample_rate_wrong: '24.10',
  manifest_missing: '24.11',
  archive_empty: '24.10',
  budget_exceeded: '24.10',
};

export interface PackExportVerdict {
  readonly satisfied: boolean;
  readonly faults: readonly PackExportFault[];
  readonly fileCount: number;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  /** Requirement 34.6. */
  readonly qualityThresholdSetVersion: number;
}

/** Requirement 24.10's stopwatch, on its own. Inclusive at the budget. */
export function withinExportBudget(elapsedMs: number, budgetMs: number): boolean {
  // `!(elapsedMs > budgetMs)` would accept a NaN elapsed time; this rejects it, because an
  // export whose duration could not be measured has not been shown to meet the budget.
  return Number.isFinite(elapsedMs) && elapsedMs <= budgetMs;
}

/**
 * Requirements 24.10 and 24.11 over a whole export report.
 *
 * Every fault is collected rather than the first returned, in `PACK_EXPORT_FAULTS` order.
 * An export that produced 154 files at the wrong rate has two problems and a caller fixing
 * it wants both.
 */
export function evaluatePackExport(
  report: PackExportReport,
  thresholds: PackExportThresholds,
): PackExportVerdict {
  const faults: PackExportFault[] = [];

  if (report.files.length !== PACK_EXPORT_FILE_COUNT) faults.push('file_count_mismatch');

  // Every cue in every format, checked as coverage rather than as a count: 156 files could
  // in principle be 78 mp3s twice over, which passes a count and fails the clause.
  if (!coversEveryFormat(report.files)) faults.push('format_coverage_incomplete');

  if (report.files.some((file) => file.sampleRate !== PACK_EXPORT_SAMPLE_RATE)) {
    faults.push('sample_rate_wrong');
  }

  if (report.manifestEntry.length === 0) faults.push('manifest_missing');
  if (report.archiveByteSize <= 0) faults.push('archive_empty');
  if (!withinExportBudget(report.elapsedMs, thresholds.exportBudgetMs)) {
    faults.push('budget_exceeded');
  }

  return {
    satisfied: faults.length === 0,
    faults,
    fileCount: report.files.length,
    elapsedMs: report.elapsedMs,
    budgetMs: thresholds.exportBudgetMs,
    qualityThresholdSetVersion: thresholds.version,
  };
}

function coversEveryFormat(files: readonly ExportedCueFile[]): boolean {
  const seen = new Map<string, Set<string>>();
  for (const file of files) {
    const formats = seen.get(file.cueName) ?? new Set<string>();
    formats.add(file.format);
    seen.set(file.cueName, formats);
  }
  for (const formats of seen.values()) {
    for (const format of PACK_EXPORT_FORMATS) {
      if (!formats.has(format)) return false;
    }
  }
  return seen.size > 0;
}
