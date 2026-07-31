import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  mixdownLengthMs,
  peakNormalisation,
  planMixdown,
  MIXDOWN_ATTENUATION_DB_MAX,
  NORMALISED_PEAK_MAX,
  NORMALISED_PEAK_MIN,
} from '../../domain/timeline/mixdown';
import { clipEndTimeMs, type TimelineProject } from '../../domain/timeline/project';
import { renderTargetSet } from '../../domain/timeline/render-target';
import { validProject } from '../support/timeline-harness';

/**
 * The mixdown *plan*, over generated projects — **all unnumbered**.
 *
 * Design §10's Properties 12 and 13 (mixdown commutativity and reproducibility, Requirements
 * 28.26 and 28.27) are task 4.2's, and they live in **`dsp/test/test_mixdown.py`**: both are
 * stated over samples, and samples exist only on the DSP side of the seam — the product layer
 * decides *which* clips render and never sees a buffer. Design §10's Python harness is
 * `hypothesis`, so that is where they are, at 100 examples each.
 *
 * Everything in this file is therefore labelled **unnumbered**, following the convention
 * `test/property/cue-pack-manifest.test.ts` and `test/property/timeline-project.test.ts` use, so
 * task 9.2's coverage audit does not count these against Properties 12 or 13.
 *
 * What they *are* is the half of the two invariants that is decidable without audio, and it is
 * worth having separately: Property 12 can only hold if the plan is insensitive to the order the
 * project lists its clips in, and Property 13 can only hold if planning the same project twice
 * plans it the same way. Those are pure functions of the project, and checking them here means a
 * failure points at the plan rather than at the renderer.
 *
 * The generator is `validProject` from `test/support/timeline-harness.ts`, which *constructs*
 * valid layouts instead of filtering for them — see that file's header.
 */

/** The same project with its clip list permuted. Requirement 28.26's antecedent. */
function permuted(project: TimelineProject, rotation: number): TimelineProject {
  const clips = [...project.clips];
  const offset = clips.length === 0 ? 0 : rotation % clips.length;
  return { ...project, clips: [...clips.slice(offset), ...clips.slice(0, offset)].reverse() };
}

describe('the mixdown plan is order-insensitive (unnumbered; supports Property 12)', () => {
  it('plans the same clips in the same order whatever order the project lists them in', async () => {
    await fc.assert(
      fc.asyncProperty(validProject({ minClips: 1 }), fc.nat(), async (project, rotation) => {
        const first = planMixdown(project);
        const second = planMixdown(permuted(project, rotation));

        // Both must agree about *whether* there is anything to render, too.
        expect(second.ok).toBe(first.ok);
        if (!first.ok || !second.ok) return;

        expect(second.clips.map((clip) => clip.id)).toEqual(first.clips.map((clip) => clip.id));
        expect(second.lengthMs).toBe(first.lengthMs);
        expect(second.sourceAssetIds).toEqual(first.sourceAssetIds);
      }),
      { numRuns: 200 },
    );
  });

  it('orders the clips strictly ascending by id', async () => {
    await fc.assert(
      fc.asyncProperty(validProject({ minClips: 1 }), async (project) => {
        const plan = planMixdown(project);
        if (!plan.ok) return;

        const ids = plan.clips.map((clip) => clip.id);
        // Strictly ascending, not merely sorted: Requirement 28.26 quantifies over a clip
        // *set*, and duplicate ids would make "the same set in another order" ill-defined.
        for (let index = 1; index < ids.length; index += 1) {
          expect(ids[index - 1]! < ids[index]!).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('the mixdown plan is a function of the project (unnumbered; supports Property 13)', () => {
  it('plans identically three times over', async () => {
    await fc.assert(
      fc.asyncProperty(validProject(), async (project) => {
        // Requirement 28.27's 3회, at the level this side of the seam can check: nothing in
        // the plan reads a clock, a random number or an environment.
        const runs = [planMixdown(project), planMixdown(project), planMixdown(project)];
        expect(runs[1]).toEqual(runs[0]);
        expect(runs[2]).toEqual(runs[0]);
      }),
      { numRuns: 200 },
    );
  });
});

describe('the planned length excludes what is not rendered (unnumbered; Requirement 28.25)', () => {
  it('is the latest end time among the render targets and no other clip', async () => {
    await fc.assert(
      fc.asyncProperty(validProject(), async (project) => {
        const plan = planMixdown(project);
        const targets = renderTargetSet(project);

        if (!plan.ok) {
          expect(targets.clips).toHaveLength(0);
          return;
        }

        expect(plan.lengthMs).toBe(mixdownLengthMs(targets.clips));

        // Every target ends at or before the mix end, and the mix ends exactly where one of
        // them does — so no excluded clip can have lengthened it.
        const ends = plan.clips.map((clip) => clipEndTimeMs(clip));
        for (const end of ends) expect(end).toBeLessThanOrEqual(plan.lengthMs);
        expect(ends).toContain(plan.lengthMs);
      }),
      { numRuns: 200 },
    );
  });

  it('refuses exactly when the render target set is empty (Requirement 28.29)', async () => {
    await fc.assert(
      fc.asyncProperty(validProject(), async (project) => {
        const plan = planMixdown(project);
        const targets = renderTargetSet(project);

        expect(plan.ok).toBe(targets.clips.length > 0);
        if (!plan.ok) {
          // The two reasons are distinguishable, and which one applies is determined by the
          // project rather than chosen.
          expect(plan.reason).toBe(
            project.clips.length === 0 ? 'project_has_no_clips' : 'all_clips_excluded',
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('peak normalisation over arbitrary peaks (unnumbered; Requirement 28.28)', () => {
  it('lands the peak in the window and reports a positive attenuation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 1.0000001, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        async (peak) => {
          const verdict = peakNormalisation(peak);
          expect(verdict.applied).toBe(true);

          const normalised = peak * verdict.coefficient;
          expect(normalised).toBeGreaterThanOrEqual(NORMALISED_PEAK_MIN);
          expect(normalised).toBeLessThanOrEqual(NORMALISED_PEAK_MAX);

          // Requirement 28.28's "0데시벨 초과" always holds; its "40데시벨 이하" cannot for a
          // loud enough mix, and that is reported rather than hidden. See
          // `domain/timeline/mixdown.ts`'s header.
          expect(verdict.attenuationDb).toBeGreaterThan(0);
          expect(verdict.withinReportableRange).toBe(
            verdict.attenuationDb <= MIXDOWN_ATTENUATION_DB_MAX,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never attenuates a peak at or below the ceiling', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        async (peak) => {
          const verdict = peakNormalisation(peak);
          // Requirement 28.24: samples unchanged, 0 dB recorded.
          expect(verdict.applied).toBe(false);
          expect(verdict.coefficient).toBe(1);
          expect(verdict.attenuationDb).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
