import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MIXDOWN_ATTENUATION_DB_MAX,
  MIXDOWN_LENGTH_TOLERANCE_MS,
  MIXDOWN_PEAK_CEILING,
  MIXDOWN_REPRODUCIBILITY_RUNS,
  MIXDOWN_SAMPLE_DIFFERENCE_TOLERANCE,
  MIX_METADATA_FIELDS,
  NORMALISATION_TARGET_PEAK,
  NORMALISED_PEAK_MAX,
  NORMALISED_PEAK_MIN,
  compareClipIds,
  mixdownLengthMs,
  mixdownLengthWithinTolerance,
  normalisedPeakWithinWindow,
  peakNormalisation,
  planMixdown,
  sortClipsForSummation,
} from '../../../domain/timeline/mixdown';
import { QUALITY_THRESHOLD_NAMES } from '../../../domain/quality/threshold-name';
import { clip, effectChain, projectWith } from '../../support/timeline-harness';

/**
 * The mixdown rules that are decidable without audio (Requirements 28.24–28.29).
 *
 * **Validates: Requirements 28.24, 28.25, 28.26, 28.28, 28.29**
 *
 * No audio anywhere in this file, deliberately. The samples are rendered in
 * `dsp/src/musicstudio_dsp/mixdown.py` and the two invariants stated over them —
 * Requirement 28.26's commutativity and 28.27's reproducibility, design §10's Properties 12
 * and 13 — are asserted in `dsp/test/test_mixdown.py`, where real buffers exist. What is
 * checked here is the half that cannot be checked from Python: the plan (which clips, in what
 * order, how long), the refusal, and the normalisation arithmetic that the *stored* attenuation
 * is computed from.
 */

function withTracks(
  clips: Parameters<typeof projectWith>[0],
  overrides: Record<number, { muted?: boolean; solo?: boolean; volumeDb?: number }>,
) {
  const project = projectWith(clips);
  return {
    ...project,
    tracks: project.tracks.map((track, index) => ({ ...track, ...(overrides[index] ?? {}) })),
  };
}

describe('mixdown length (Requirement 28.25)', () => {
  it('runs from 0 to the latest clip end', () => {
    const clips = [
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
      clip({ id: 'b', track: 1, startTimeMs: 5_000, sourceDurationMs: 2_000 }),
    ];
    expect(mixdownLengthMs(clips)).toBe(7_000);
  });

  it('accounts for trims, because play length is what 28.25 is stated over', () => {
    const trimmed = clip({
      id: 'a',
      startTimeMs: 1_000,
      sourceDurationMs: 10_000,
      trimStartMs: 2_000,
      trimEndMs: 3_000,
    });
    // 1000 + (10000 - 2000 - 3000)
    expect(mixdownLengthMs([trimmed])).toBe(6_000);
  });

  it('is 0 for an empty target set', () => {
    // Never rendered — Requirement 28.29 refuses first — but the function is total.
    expect(mixdownLengthMs([])).toBe(0);
  });

  it('excludes clips that are not render targets', () => {
    // Requirement 28.25's second half, through the plan: the muted clip is the longest one
    // and must not lengthen the mix.
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
      clip({ id: 'b', track: 1, startTimeMs: 60_000, sourceDurationMs: 1_000, muted: true }),
    ]);
    const plan = planMixdown(project);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.lengthMs).toBe(1_000);
  });

  it('applies the 10 ms tolerance in both directions and rejects NaN', () => {
    expect(mixdownLengthWithinTolerance(1_000, 1_010)).toBe(true);
    expect(mixdownLengthWithinTolerance(1_000, 990)).toBe(true);
    expect(mixdownLengthWithinTolerance(1_000, 1_010.1)).toBe(false);
    // A NaN produced length must fail rather than slip through a `>` comparison.
    expect(mixdownLengthWithinTolerance(1_000, Number.NaN)).toBe(false);
  });
});

describe('summation order (Requirement 28.26)', () => {
  it('sorts by clip id', () => {
    const clips = [
      clip({ id: 'c-3', track: 0, startTimeMs: 0 }),
      clip({ id: 'c-1', track: 1, startTimeMs: 0 }),
      clip({ id: 'c-2', track: 2, startTimeMs: 0 }),
    ];
    expect(sortClipsForSummation(clips).map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('does not mutate its argument', () => {
    const clips = [clip({ id: 'z', track: 0 }), clip({ id: 'a', track: 1 })];
    sortClipsForSummation(clips);
    expect(clips.map((c) => c.id)).toEqual(['z', 'a']);
  });

  it('compares by code unit rather than by locale', () => {
    // `localeCompare` orders 'a' before 'B' in most locales; code-unit order does not. Two
    // workers must agree (Requirement 28.27) and ICU data is a property of the process.
    expect(compareClipIds(clip({ id: 'B' }), clip({ id: 'a' }))).toBeLessThan(0);
    expect(compareClipIds(clip({ id: 'a' }), clip({ id: 'a' }))).toBe(0);
  });

  it('produces the same order whatever order the project lists the clips in', () => {
    const a = clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 });
    const b = clip({ id: 'b', track: 1, startTimeMs: 0, sourceDurationMs: 1_000 });
    const forward = planMixdown(projectWith([a, b]));
    const reverse = planMixdown(projectWith([b, a]));
    expect(forward.ok && reverse.ok).toBe(true);
    if (forward.ok && reverse.ok) {
      expect(forward.clips.map((c) => c.id)).toEqual(reverse.clips.map((c) => c.id));
      expect(forward.lengthMs).toBe(reverse.lengthMs);
    }
  });
});

describe('the plan consumes the render target set (Requirements 28.19, 28.20)', () => {
  it('does not recompute which clips render', () => {
    // A muted track and a soloed one: the plan must agree with `renderTargetSet` exactly,
    // including that mute beats solo.
    const project = withTracks(
      [
        clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
        clip({ id: 'b', track: 1, startTimeMs: 0, sourceDurationMs: 1_000 }),
        clip({ id: 'c', track: 2, startTimeMs: 0, sourceDurationMs: 1_000 }),
      ],
      { 1: { solo: true }, 2: { solo: true, muted: true } },
    );
    const plan = planMixdown(project);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.clips.map((c) => c.id)).toEqual(['b']);
      expect(plan.soloActive).toBe(true);
      expect(plan.excluded).toEqual([
        { clipId: 'a', reason: 'not_soloed' },
        { clipId: 'c', reason: 'track_muted' },
      ]);
    }
  });

  it('lists the distinct source assets in summation order', () => {
    const plan = planMixdown(
      projectWith([
        clip({ id: 'b', assetId: 'asset-2', track: 1, startTimeMs: 0 }),
        clip({ id: 'a', assetId: 'asset-1', track: 0, startTimeMs: 0 }),
        clip({ id: 'c', assetId: 'asset-1', track: 2, startTimeMs: 0 }),
      ]),
    );
    expect(plan.ok).toBe(true);
    // Requirement 19.6's list is of *assets*, so the duplicate reference collapses.
    if (plan.ok) expect(plan.sourceAssetIds).toEqual(['asset-1', 'asset-2']);
  });
});

describe('the empty render target set (Requirement 28.29)', () => {
  it('refuses a project with no clips, saying so', () => {
    const plan = planMixdown(projectWith([]));
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe('project_has_no_clips');
      expect(plan.excluded).toEqual([]);
    }
  });

  it('refuses a project whose every clip is muted, and says which', () => {
    const plan = planMixdown(
      projectWith([
        clip({ id: 'a', track: 0, startTimeMs: 0, muted: true }),
        clip({ id: 'b', track: 1, startTimeMs: 0, muted: true }),
      ]),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      // A user can act on the difference between the two reasons, which is why they are two.
      expect(plan.reason).toBe('all_clips_excluded');
      expect(plan.excluded.map((e) => e.clipId)).toEqual(['a', 'b']);
    }
  });

  it('refuses a project whose clips are all on unsoloed tracks', () => {
    const project = withTracks([clip({ id: 'a', track: 0, startTimeMs: 0 })], {
      5: { solo: true },
    });
    const plan = planMixdown(project);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe('all_clips_excluded');
  });
});

describe('peak normalisation (Requirements 28.24, 28.28)', () => {
  it('leaves a mix at or below the ceiling alone and records 0 dB', () => {
    for (const peak of [0, 0.5, MIXDOWN_PEAK_CEILING]) {
      const verdict = peakNormalisation(peak);
      expect(verdict.applied).toBe(false);
      expect(verdict.coefficient).toBe(1);
      expect(verdict.attenuationDb).toBe(0);
    }
  });

  it('brings an overshoot into the 0.99–1.0 window with a single coefficient', () => {
    for (const peak of [1.0001, 1.5, 2, 10, 99]) {
      const verdict = peakNormalisation(peak);
      expect(verdict.applied).toBe(true);
      const normalised = peak * verdict.coefficient;
      expect(normalisedPeakWithinWindow(normalised)).toBe(true);
      expect(normalised).toBeCloseTo(NORMALISATION_TARGET_PEAK, 10);
      // Requirement 28.28: 0 dB 초과 40 dB 이하.
      expect(verdict.attenuationDb).toBeGreaterThan(0);
      expect(verdict.attenuationDb).toBeLessThanOrEqual(MIXDOWN_ATTENUATION_DB_MAX);
      expect(verdict.withinReportableRange).toBe(true);
    }
  });

  it('reports an attenuation beyond 40 dB rather than clamping the coefficient', () => {
    // Requirement 28.28 asks for two things a loud enough mix cannot both give; the amplitude
    // window wins and the dB figure is flagged. Reachable inside Requirement 28's own bounds:
    // a clip at +12 dB on a track at +12 dB is x15.85, and 32 tracks can sound at once.
    const verdict = peakNormalisation(500);
    expect(verdict.attenuationDb).toBeGreaterThan(MIXDOWN_ATTENUATION_DB_MAX);
    expect(verdict.withinReportableRange).toBe(false);
    expect(normalisedPeakWithinWindow(500 * verdict.coefficient)).toBe(true);
  });

  it('refuses a peak that is not a finite non-negative number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => peakNormalisation(bad)).toThrow(RangeError);
    }
  });

  it('bounds the window at exactly 0.99 and 1.0', () => {
    expect(normalisedPeakWithinWindow(NORMALISED_PEAK_MIN)).toBe(true);
    expect(normalisedPeakWithinWindow(NORMALISED_PEAK_MAX)).toBe(true);
    expect(normalisedPeakWithinWindow(0.9899)).toBe(false);
    expect(normalisedPeakWithinWindow(1.0001)).toBe(false);
  });
});

describe('mix asset metadata (Requirement 28.28)', () => {
  it('names every field the type declares, so nothing is dropped silently', () => {
    // The same guard `BGM_METADATA_FIELDS` gives Requirement 21.15's ten fields: a field
    // added to the type and not to the list is a type error rather than a field the writer
    // quietly stops sending.
    expect(new Set(MIX_METADATA_FIELDS).size).toBe(MIX_METADATA_FIELDS.length);
    expect(MIX_METADATA_FIELDS).toContain('attenuationDb');
  });

  it('records which clips\' Effect_Chains went into the mix (Requirement 29.31)', () => {
    // Requirement 28.27's reproducibility is only checkable against a stated parameter set, and a
    // clip's chain changes its samples exactly as its gain does. A stored mix that did not say
    // which chains it contained could not be compared with a re-render, because the project's
    // chains can be changed afterwards.
    expect(MIX_METADATA_FIELDS).toContain('effectChainClipIds');
  });
});

describe('the plan names the clips carrying an Effect_Chain (Requirement 29.31)', () => {
  it('lists them in summation order and excludes what is not rendered', () => {
    const project = projectWith([
      clip({ id: 'clip-c', track: 2, startTimeMs: 0, effectChain: effectChain(['gain']) }),
      clip({ id: 'clip-a', track: 0, startTimeMs: 0, effectChain: effectChain(['reverb']) }),
      clip({ id: 'clip-b', track: 1, startTimeMs: 0 }),
      // Muted: Requirement 28.20 keeps it out of the render, so its chain is out too.
      clip({ id: 'clip-d', track: 3, startTimeMs: 0, muted: true, effectChain: effectChain(['delay']) }),
    ]);

    const plan = planMixdown(project);

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      // Ascending clip id, matching `clips`, and no `clip-d`.
      expect(plan.effectChainClipIds).toEqual(['clip-a', 'clip-c']);
    }
  });

  it('is empty for a project whose clips carry no chains', () => {
    const plan = planMixdown(projectWith([clip({ id: 'clip-a', track: 0 })]));
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.effectChainClipIds).toEqual([]);
  });
});

describe('bounds, not Quality_Threshold_Set members', () => {
  it('keeps 28.26 and 28.28 out of the threshold set', () => {
    // See the header of `domain/timeline/mixdown.ts` for the argument. Asserted so that a
    // later task adding either as a threshold has to confront the reasoning — and so that
    // the exhaustive list in `test/unit/bgm/threshold-set.test.ts` stays unchanged.
    const names: readonly string[] = QUALITY_THRESHOLD_NAMES;
    expect(names).not.toContain('mixdown_sample_difference_tolerance');
    expect(names).not.toContain('mixdown_normalised_peak_min');
    expect(names).not.toContain('mixdown_length_tolerance_ms');
  });
});

/**
 * Parity with `dsp/src/musicstudio_dsp/mixdown.py`.
 *
 * Same reasoning as `test/unit/effects/registry-parity.test.ts`: the numbers of Requirements
 * 28.25, 28.26 and 28.28 are enforced on both sides of the seam — here, because the stored
 * attenuation and the length check are computed in the product layer, and in the worker,
 * because that is where the coefficient is applied. Two enforcement points are only "the same
 * numbers" for as long as something checks.
 *
 * The Python module is read as text rather than executed: no Python process is started, so this
 * runs in the fast loop with the other parity suites.
 */
describe('parity with the DSP worker', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../dsp/src/musicstudio_dsp/mixdown.py', import.meta.url)),
    'utf8',
  );

  function pythonConstant(name: string): number {
    const match = new RegExp(`^${name} = ([-0-9.eE_]+)$`, 'm').exec(source);
    if (match === null) throw new Error(`${name} is not declared in mixdown.py`);
    return Number(match[1]);
  }

  it.each([
    ['PEAK_CEILING', MIXDOWN_PEAK_CEILING],
    ['NORMALISED_PEAK_MIN', NORMALISED_PEAK_MIN],
    ['NORMALISED_PEAK_MAX', NORMALISED_PEAK_MAX],
    ['NORMALISATION_TARGET_PEAK', NORMALISATION_TARGET_PEAK],
    ['ATTENUATION_DB_MAX', MIXDOWN_ATTENUATION_DB_MAX],
    ['MIXDOWN_LENGTH_TOLERANCE_MS', MIXDOWN_LENGTH_TOLERANCE_MS],
    ['SAMPLE_DIFFERENCE_TOLERANCE', MIXDOWN_SAMPLE_DIFFERENCE_TOLERANCE],
  ])('agrees with the worker on %s', (name, expected) => {
    expect(pythonConstant(name)).toBe(expected);
  });

  it('agrees on the reproducibility run count', () => {
    // Requirement 28.27's 3, which the Python side states as a class attribute of the
    // property rather than as a module constant.
    expect(MIXDOWN_REPRODUCIBILITY_RUNS).toBe(3);
  });
});
