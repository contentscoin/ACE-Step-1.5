import { describe, expect, it } from 'vitest';

import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import { LOOP_SEAM_CRITERIA } from '../../../domain/bgm/loop-seam';
import { SFX_LOOP_SEAM_CRITERIA } from '../../../domain/sfx/loop-seam';
import { CUE_SEAM_WINDOW_MS, CUE_TAIL_WINDOW_MS } from '../../../domain/sound-pack/bounds';
import {
  PACK_LOOP_SEAM_CRITERIA,
  evaluateCueLoopSeam,
  seamOffenders,
} from '../../../domain/sound-pack/loop-seam';
import {
  SOUND_PACK_STATUSES,
  isSoundPackStatus,
  packStatus,
} from '../../../domain/sound-pack/status';
import {
  judgeCueLength,
  lengthOffenders,
  validateSoundPackRequest,
} from '../../../domain/sound-pack/validation';
import { measureLoopSync } from '../../../services/sound/in-process-measurement';
import { distinctSeamlessLoop } from '../../support/cue-synthesis';
import { alternating, monoAudio } from '../../support/pcm-synthesis';

/**
 * Requirements 24.1, 24.4, 24.5, 24.6 and 24.20 as pure rules, plus the pack status vocabulary.
 */

const thresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);

describe('Requirement 24.20: the request rules', () => {
  it('accepts a name and description inside 24.1\'s ranges', () => {
    const result = validateSoundPackRequest({ name: 'Soft', description: 'warm and muted' });

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.parameters).toEqual({ name: 'Soft', description: 'warm and muted' });
  });

  it('returns the field, the input length and the permitted range', () => {
    const result = validateSoundPackRequest({ name: 'x'.repeat(61), description: 'ok' });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.lengths).toEqual([{ field: 'name', actualLength: 61 }]);
    expect(result.violations[0]?.field).toBe('name');
    expect(result.violations[0]?.allowed).toEqual({
      kind: 'length',
      minLength: 1,
      maxLength: 60,
    });
  });

  it('reports a missing field as length 0, which is outside the range anyway', () => {
    const result = validateSoundPackRequest({
      name: undefined as unknown as string,
      description: 'ok',
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.lengths).toEqual([{ field: 'name', actualLength: 0 }]);
  });

  it('reports both fields when both are wrong, in field order', () => {
    const result = validateSoundPackRequest({ name: '', description: 'y'.repeat(201) });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.lengths.map((entry) => entry.field)).toEqual(['name', 'description']);
    expect(result.lengths[1]?.actualLength).toBe(201);
  });
});

describe('Requirements 24.4 and 24.5: the length rules', () => {
  it('judges a one-shot against 50–1 500 ms and a loop against 500–4 000 ms', () => {
    expect(judgeCueLength('hover', 200)).toMatchObject({
      loop: false,
      minMs: 50,
      maxMs: 1_500,
      placement: 'within',
      satisfied: true,
    });
    expect(judgeCueLength('loading', 1_000)).toMatchObject({
      loop: true,
      minMs: 500,
      maxMs: 4_000,
      placement: 'within',
    });
  });

  it('takes the kind from the taxonomy, so the ranges cannot be mixed up', () => {
    // The same 200 ms passes as a one-shot and fails as a loop, and the caller does not choose.
    expect(judgeCueLength('hover', 200).satisfied).toBe(true);
    expect(judgeCueLength('loading', 200).placement).toBe('too_short');
  });

  it('is inclusive at both ends', () => {
    expect(judgeCueLength('hover', 50).satisfied).toBe(true);
    expect(judgeCueLength('hover', 1_500).satisfied).toBe(true);
    expect(judgeCueLength('hover', 49.9).placement).toBe('too_short');
    expect(judgeCueLength('hover', 1_500.1).placement).toBe('too_long');
  });

  it('treats an unmeasurable length as too short rather than as acceptable', () => {
    expect(judgeCueLength('hover', Number.NaN).satisfied).toBe(false);
    expect(judgeCueLength('hover', 0).placement).toBe('too_short');
  });

  it('lists the offenders in cue order', () => {
    const verdicts = [
      judgeCueLength('hover', 200),
      judgeCueLength('press', 5_000),
      judgeCueLength('loading', 100),
    ];

    expect(lengthOffenders(verdicts).map((entry) => entry.cueName)).toEqual(['press', 'loading']);
  });
});

describe('Requirement 24.6: two seam criteria, not one', () => {
  it('applies the RMS difference *and* the sample step', () => {
    expect([...PACK_LOOP_SEAM_CRITERIA]).toEqual(['seam_rms_difference', 'seam_sample_step']);
    // Strictly stronger than Requirement 22.14, which is the reason this module exists.
    expect([...SFX_LOOP_SEAM_CRITERIA]).toEqual(['seam_rms_difference']);
    for (const criterion of PACK_LOOP_SEAM_CRITERIA) {
      expect(LOOP_SEAM_CRITERIA).toContain(criterion);
    }
  });

  it('does not apply edge energy or bar alignment, which 24.6 does not name', () => {
    expect(PACK_LOOP_SEAM_CRITERIA).not.toContain('edge_energy');
    expect(PACK_LOOP_SEAM_CRITERIA).not.toContain('bar_alignment');
  });

  it('accepts a loop whose seam windows hold identical samples', () => {
    const audio = distinctSeamlessLoop(4_242, { durationMs: 600 });

    const verdict = evaluateCueLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio },
        bpm: 0,
        timeSignature: 0,
        seamWindowMs: CUE_SEAM_WINDOW_MS,
      }),
      thresholds,
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.unmet).toEqual([]);
  });

  it('rejects a loop that clicks at the seam even though its energy matches', () => {
    // An alternating-sign signal has identical RMS in both seam windows — so Requirement 22.14
    // admits it — and a sample step of four times the peak, which 24.6 rejects. That is exactly
    // the gap `domain/sfx/loop-seam.ts` records as an open question.
    const audio = monoAudio(alternating(48_000, 0.5));

    const measurement = measureLoopSync({
      subject: { kind: 'pcm', audio },
      bpm: 0,
      timeSignature: 0,
      seamWindowMs: CUE_SEAM_WINDOW_MS,
    });

    expect(evaluateCueLoopSeam(measurement, thresholds).unmet).toEqual(['seam_sample_step']);
  });

  it('reports the offending loop cues', () => {
    const bad = evaluateCueLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio: monoAudio(alternating(48_000, 0.5)) },
        bpm: 0,
        timeSignature: 0,
        seamWindowMs: CUE_SEAM_WINDOW_MS,
      }),
      thresholds,
    );
    const good = evaluateCueLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio: distinctSeamlessLoop(11, { durationMs: 600 }) },
        bpm: 0,
        timeSignature: 0,
        seamWindowMs: CUE_SEAM_WINDOW_MS,
      }),
      thresholds,
    );

    expect(
      seamOffenders([
        { cueName: 'loading', verdict: good },
        { cueName: 'processing', verdict: bad },
      ]).map((entry) => entry.cueName),
    ).toEqual(['processing']);
  });

  it('states 24.6\'s and 24.8\'s windows as the clauses do', () => {
    expect(CUE_SEAM_WINDOW_MS).toBe(10);
    expect(CUE_TAIL_WINDOW_MS).toBe(50);
  });
});

describe('the pack status vocabulary', () => {
  const clean = {
    missingCueNames: [] as readonly string[],
    unresolvedSimilarPairs: 0,
    loudnessOffenders: 0,
    lengthOffenders: 0,
    seamOffenders: 0,
  };

  it('has exactly three states, ordered least to most attention', () => {
    expect([...SOUND_PACK_STATUSES]).toEqual(['complete', 'review_required', 'incomplete']);
    expect(isSoundPackStatus('complete')).toBe(true);
    expect(isSoundPackStatus('partial')).toBe(false);
  });

  it('is complete only when nothing is wrong', () => {
    expect(packStatus(clean)).toBe('complete');
  });

  it('is incomplete when a cue is missing, whatever else is wrong', () => {
    expect(packStatus({ ...clean, missingCueNames: ['hover'] })).toBe('incomplete');
    expect(
      packStatus({ ...clean, missingCueNames: ['hover'], unresolvedSimilarPairs: 4 }),
    ).toBe('incomplete');
  });

  it.each([
    ['an unresolved similar pair (24.22)', { unresolvedSimilarPairs: 1 }],
    ['a cue outside the loudness band (24.7)', { loudnessOffenders: 1 }],
    ['a cue outside its length range (24.4)', { lengthOffenders: 1 }],
    ['a loop cue with a bad seam (24.6)', { seamOffenders: 1 }],
  ])('needs review for %s', (_label, overrides) => {
    expect(packStatus({ ...clean, ...overrides })).toBe('review_required');
  });
});
