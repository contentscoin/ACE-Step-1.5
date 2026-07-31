import { describe, expect, it } from 'vitest';

import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { packExportThresholds } from '../../../domain/quality/sound-pack-thresholds';
import {
  PACK_EXPORT_FILE_COUNT,
  PACK_EXPORT_FORMATS,
  PACK_EXPORT_SAMPLE_RATE,
} from '../../../domain/sound-pack/bounds';
import {
  evaluatePackExport,
  withinExportBudget,
  type ExportedCueFile,
  type PackExportReport,
} from '../../../domain/sound-pack/export';
import { CUE_NAMES } from '../../../domain/sound-pack/taxonomy';
import {
  PACK_REGENERATION_ROUNDS,
  createSoundPackHarness,
  soundPackRequest,
} from '../../support/sound-pack-harness';
import { isGenerationError } from '../../../services/generation/errors';

/**
 * Requirements 24.10 and 24.11, as a pure judgement over an export report.
 *
 * **How the 60-second budget is tested without waiting 60 seconds.** The predicate is separated
 * from the work: the exporter measures its own wall time and this module decides whether that time
 * is acceptable. So the boundary — 0 ms, exactly the budget, one millisecond past it — is asserted
 * directly, and no test sleeps or has to arrange a slow export. The other half of the evidence is
 * in `dsp/test/test_sound_pack.py`, which builds a real 78-cue archive with `libsndfile` and
 * asserts the measured time lands far inside the budget.
 */

const thresholds = packExportThresholds(INITIAL_QUALITY_THRESHOLD_SET);

function file(cueName: string, format: (typeof PACK_EXPORT_FORMATS)[number]): ExportedCueFile {
  return {
    cueName,
    format,
    path: `sounds/${cueName}.${format}`,
    byteSize: 2_048,
    durationMs: 200,
    channels: 1,
    sampleRate: PACK_EXPORT_SAMPLE_RATE,
  };
}

function report(overrides: Partial<PackExportReport> = {}): PackExportReport {
  return {
    files: CUE_NAMES.flatMap((cueName) => PACK_EXPORT_FORMATS.map((format) => file(cueName, format))),
    elapsedMs: 500,
    manifestEntry: 'manifest.json',
    archiveByteSize: 500_000,
    ...overrides,
  };
}

describe('Requirement 24.10\'s budget, as a predicate', () => {
  it('is 60 000 ms in the initial threshold set', () => {
    expect(thresholds.exportBudgetMs).toBe(60_000);
  });

  it('is inclusive at the budget and exclusive one millisecond past it', () => {
    expect(withinExportBudget(0, 60_000)).toBe(true);
    expect(withinExportBudget(59_999, 60_000)).toBe(true);
    expect(withinExportBudget(60_000, 60_000)).toBe(true);
    expect(withinExportBudget(60_001, 60_000)).toBe(false);
  });

  it('rejects an unmeasurable elapsed time rather than admitting it', () => {
    expect(withinExportBudget(Number.NaN, 60_000)).toBe(false);
    expect(withinExportBudget(Number.POSITIVE_INFINITY, 60_000)).toBe(false);
  });

  it('is read from the threshold set, so Requirement 34.4 can move it', () => {
    expect(evaluatePackExport(report({ elapsedMs: 70_000 }), thresholds).faults).toContain(
      'budget_exceeded',
    );
    expect(
      evaluatePackExport(report({ elapsedMs: 70_000 }), {
        version: 2,
        exportBudgetMs: 120_000,
      }).satisfied,
    ).toBe(true);
  });
});

describe('Requirement 24.10\'s archive shape', () => {
  it('accepts 156 files, one mp3 and one ogg per cue, at 48 kHz', () => {
    const verdict = evaluatePackExport(report(), thresholds);

    expect(verdict.satisfied).toBe(true);
    expect(verdict.faults).toEqual([]);
    expect(verdict.fileCount).toBe(PACK_EXPORT_FILE_COUNT);
    expect(verdict.qualityThresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('rejects 154 files, which is a well-formed archive missing a sound', () => {
    const files = report().files.slice(0, PACK_EXPORT_FILE_COUNT - 2);

    const verdict = evaluatePackExport(report({ files }), thresholds);

    expect(verdict.faults).toContain('file_count_mismatch');
    expect(verdict.fileCount).toBe(154);
  });

  it('rejects 156 files that are 78 mp3s twice over — coverage, not a count', () => {
    const files = CUE_NAMES.flatMap((cueName) => [file(cueName, 'mp3'), file(cueName, 'mp3')]);

    const verdict = evaluatePackExport(report({ files }), thresholds);

    expect(verdict.fileCount).toBe(PACK_EXPORT_FILE_COUNT);
    expect(verdict.faults).toContain('format_coverage_incomplete');
  });

  it('rejects a file written at another sample rate', () => {
    const files = report().files.map((entry, index) =>
      index === 4 ? { ...entry, sampleRate: 44_100 } : entry,
    );

    expect(evaluatePackExport(report({ files }), thresholds).faults).toContain('sample_rate_wrong');
  });

  it('rejects an archive with no manifest (24.11) and an empty archive', () => {
    expect(evaluatePackExport(report({ manifestEntry: '' }), thresholds).faults).toContain(
      'manifest_missing',
    );
    expect(evaluatePackExport(report({ archiveByteSize: 0 }), thresholds).faults).toContain(
      'archive_empty',
    );
  });

  it('collects every fault rather than returning the first', () => {
    // mp3 only, so the coverage fault is real: 78 files, every cue missing its ogg.
    const files = CUE_NAMES.map((cueName) => ({
      ...file(cueName, 'mp3'),
      sampleRate: 22_050,
    }));

    const verdict = evaluatePackExport(
      report({ files, elapsedMs: 90_000, manifestEntry: '' }),
      thresholds,
    );

    expect(verdict.faults).toEqual([
      'file_count_mismatch',
      'format_coverage_incomplete',
      'sample_rate_wrong',
      'manifest_missing',
      'budget_exceeded',
    ]);
  });
});

describe('the service\'s export path (Requirements 24.10, 24.11)', () => {
  it('writes 156 files and a manifest carrying real byte sizes', async () => {
    const harness = createSoundPackHarness();
    const generated = await harness.service.generate({
      accountId: 'account-1',
      packId: 'pack-1',
      request: soundPackRequest(),
    });
    if (generated.kind !== 'produced') throw new Error('pack was blocked');

    const outcome = await harness.service.exportPack({
      packId: 'pack-1',
      packName: generated.packName,
      cues: generated.cues,
    });

    expect(outcome.verdict.satisfied).toBe(true);
    expect(outcome.verdict.fileCount).toBe(PACK_EXPORT_FILE_COUNT);
    expect(outcome.manifest.entries).toHaveLength(78);
    // Requirement 24.11's byte size, which only exists once the file has been encoded — hence the
    // two passes `exportPack` documents.
    for (const entry of outcome.manifest.entries) {
      expect(entry.byteSize).toBeGreaterThan(0);
      expect(entry.path).toBe(`sounds/${entry.cueName}.mp3`);
    }
    expect(harness.exports).toHaveLength(2);
    // The document in the archive is the one the product layer printed, byte for byte.
    expect(harness.exports[1]?.manifestDocument).toBe(outcome.manifestDocument);
  });

  it('judges the sum of both passes against the budget', async () => {
    const harness = createSoundPackHarness();
    const generated = await harness.service.generate({
      accountId: 'account-1',
      packId: 'pack-1',
      request: soundPackRequest(),
    });
    if (generated.kind !== 'produced') throw new Error('pack was blocked');
    // 31 s each: either pass alone is inside the 60 s budget and the two together are not.
    harness.setExportElapsedMs(31_000);

    const error = await harness.service
      .exportPack({ packId: 'pack-1', packName: generated.packName, cues: generated.cues })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.code).toBe('sound_pack_export_failed');
    expect(error.statusCode).toBe(500);
    expect(error.details['faults']).toEqual(['budget_exceeded']);
    expect(error.details['elapsedMs']).toBe(62_000);
  });

  it('fails rather than returning a short archive', async () => {
    const harness = createSoundPackHarness();
    const generated = await harness.service.generate({
      accountId: 'account-1',
      packId: 'pack-1',
      request: soundPackRequest(),
    });
    if (generated.kind !== 'produced') throw new Error('pack was blocked');
    harness.dropExportFiles(2);

    const error = await harness.service
      .exportPack({ packId: 'pack-1', packName: generated.packName, cues: generated.cues })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.details['faults']).toContain('file_count_mismatch');
    expect(error.details['requiredFileCount']).toBe(PACK_EXPORT_FILE_COUNT);
  });
});

describe('constants the harness and the requirement share', () => {
  it('agrees with Requirement 24.22 on the regeneration round count', () => {
    expect(PACK_REGENERATION_ROUNDS).toBe(3);
  });
});
