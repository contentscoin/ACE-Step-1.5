/**
 * The demo fixtures are valid under the domain's own rules.
 *
 * **Validates: Requirements 28.5, 28.8, 28.13, 28.16, 28.17, 29.9, 29.10, 29.13, 30.22**
 *
 * A fixture is not usually worth a test. This one is, because it is the *input* to every screen
 * test in this directory: a project that violated a rule would make a screen's refusal look like a
 * bug in the screen, and — worse — an invalid clip can pass a rendering test that never asks the
 * domain anything. The first draft of `seedProject` read `trimEndMs` as an absolute end position
 * rather than an amount removed and gave two of its three clips a play length of zero. Every
 * screen test still passed.
 *
 * So this file asks the domain, not the screen.
 */

import { describe, expect, it } from 'vitest';

import { chainViolations } from '@domain/effects/chain';
import { isWellFormedMeasurement } from '@domain/mastering/measurement';
import { suggestionDefects } from '@domain/mastering/suggestion';
import { CLIP_PLAY_LENGTH_MIN_MS } from '@domain/timeline/bounds';
import { clipPlayLengthMs, findOverlaps, projectViolations } from '@domain/timeline/project';

import { seedProject, seedSuggestion } from '../../src/lib/api/seed';

describe('seedProject', () => {
  it('is a valid project', () => {
    expect(projectViolations(seedProject())).toEqual([]);
  });

  it('gives every clip a play length the domain accepts', () => {
    for (const clip of seedProject().clips) {
      expect(clipPlayLengthMs(clip)).toBeGreaterThanOrEqual(CLIP_PLAY_LENGTH_MIN_MS);
    }
  });

  it('starts with no overlaps, so a refusal in a screen test is the edit’s doing', () => {
    const project = seedProject();
    for (const clip of project.clips) {
      expect(findOverlaps(project, clip)).toEqual([]);
    }
  });

  it('leaves an overlap reachable on track 0, which Requirement 28.8’s test needs', () => {
    const project = seedProject();
    const onTrackZero = project.clips.filter((clip) => clip.track === 0);
    // Two clips on one track is what makes a move refusable at all; one clip could never collide.
    expect(onTrackZero.length).toBeGreaterThanOrEqual(2);
  });
});

describe('seedSuggestion', () => {
  it('is a suggestion the domain would accept from a model', () => {
    expect(suggestionDefects(seedSuggestion())).toEqual([]);
  });

  it('names only registered effects and in-range parameters (Reqs 29.9, 29.10)', () => {
    expect(chainViolations(seedSuggestion().chain.items)).toEqual([]);
  });

  it('reports the ten octave bands in order (Req 30.22)', () => {
    expect(isWellFormedMeasurement(seedSuggestion().measurement)).toBe(true);
  });
});
