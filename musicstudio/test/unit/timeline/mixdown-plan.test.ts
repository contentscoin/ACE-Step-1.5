import { describe, expect, it } from 'vitest';

import {
  ATTENUATION_DB_MAX,
  clipEndMs,
  clipPlayDurationMs,
  isAppliedAttenuationDb,
  isReportableAttenuationDb,
  MIXDOWN_LENGTH_TOLERANCE_MS,
  mixdownLengthMs,
  planMixdown,
} from '../../../domain/timeline/mixdown';
import { clip, projectWith } from '../../support/timeline-harness';

/**
 * Requirements 28.13, 28.24, 28.25, 28.28, 28.29 — the numbers the product layer states
 * before the DSP worker runs. Rendering itself is `dsp/test/test_mixdown.py`.
 */

describe('clip play duration (Requirement 28.13)', () => {
  it('is the source length less both trims', () => {
    const trimmed = clip({ sourceDurationMs: 10_000, trimStartMs: 1_500, trimEndMs: 2_500 });
    expect(clipPlayDurationMs(trimmed)).toBe(6_000);
  });

  it('places the clip end at its start plus its play length', () => {
    const trimmed = clip({ sourceDurationMs: 10_000, trimEndMs: 4_000, startTimeMs: 2_000 });
    expect(clipEndMs(trimmed)).toBe(8_000);
  });
});

describe('mixdown length (Requirement 28.25)', () => {
  it('runs from zero to the latest clip end', () => {
    expect(
      mixdownLengthMs([
        clip({ id: 'a', startTimeMs: 0, sourceDurationMs: 5_000 }),
        clip({ id: 'b', startTimeMs: 3_000, sourceDurationMs: 4_000 }),
      ]),
    ).toBe(7_000);
  });

  it('is not extended by a clip that ends earlier than another', () => {
    expect(
      mixdownLengthMs([
        clip({ id: 'a', startTimeMs: 0, sourceDurationMs: 9_000 }),
        clip({ id: 'b', startTimeMs: 1_000, sourceDurationMs: 1_000 }),
      ]),
    ).toBe(9_000);
  });

  it('is zero for an empty target set', () => {
    expect(mixdownLengthMs([])).toBe(0);
  });

  it('counts a trimmed clip by what it plays, not by its source', () => {
    const trimmed = clip({ startTimeMs: 0, sourceDurationMs: 10_000, trimEndMs: 6_000 });
    expect(mixdownLengthMs([trimmed])).toBe(4_000);
  });
});

describe('attenuation reporting band (Requirements 28.24, 28.28)', () => {
  it('accepts a figure inside the applied band', () => {
    expect(isAppliedAttenuationDb(0.5)).toBe(true);
    expect(isAppliedAttenuationDb(ATTENUATION_DB_MAX)).toBe(true);
  });

  it('rejects zero as an applied figure — 28.24 reports that case separately', () => {
    expect(isAppliedAttenuationDb(0)).toBe(false);
    expect(isReportableAttenuationDb(0)).toBe(true);
  });

  it('rejects a figure past the ceiling and anything non-finite', () => {
    expect(isAppliedAttenuationDb(ATTENUATION_DB_MAX + 0.001)).toBe(false);
    expect(isReportableAttenuationDb(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isReportableAttenuationDb(Number.NaN)).toBe(false);
    expect(isReportableAttenuationDb(-1)).toBe(false);
  });
});

describe('mixdown plan (Requirement 28.29)', () => {
  it('rejects a project with no clips at all', () => {
    const plan = planMixdown(projectWith([]));
    expect(plan.rejection).toBe('no_render_target');
    expect(plan.target.clips).toHaveLength(0);
  });

  it('rejects when mute left nothing, and says which clips were excluded', () => {
    const plan = planMixdown(
      projectWith([clip({ id: 'a', muted: true }), clip({ id: 'b', track: 1, muted: true })]),
    );

    expect(plan.rejection).toBe('no_render_target');
    expect(plan.target.excluded.map((entry) => entry.clipId)).toEqual(['a', 'b']);
    expect(plan.target.excluded.every((entry) => entry.reason === 'clip_muted')).toBe(true);
  });

  it('rejects when solo left nothing on the soloed track', () => {
    const project = projectWith([clip({ id: 'a', track: 0 })]);
    const soloedElsewhere = {
      ...project,
      tracks: project.tracks.map((track, index) => ({ ...track, solo: index === 5 })),
    };

    const plan = planMixdown(soloedElsewhere);
    expect(plan.rejection).toBe('no_render_target');
    expect(plan.target.excluded[0]?.reason).toBe('not_soloed');
  });

  it('plans a length over the surviving clips only', () => {
    const plan = planMixdown(
      projectWith([
        clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
        clip({ id: 'b', track: 1, startTimeMs: 8_000, sourceDurationMs: 1_000, muted: true }),
      ]),
    );

    expect(plan.rejection).toBeNull();
    // The muted clip would have reached 9 000 ms; 28.25 excludes it.
    expect(plan.lengthMs).toBe(1_000);
  });

  it('keeps the tolerance the seam is checked against at Requirement 28.25 s value', () => {
    expect(MIXDOWN_LENGTH_TOLERANCE_MS).toBe(10);
  });
});
