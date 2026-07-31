import { describe, expect, it } from 'vitest';

import { PLAYHEAD_TOLERANCE_MS, TRACK_COUNT } from '../../../domain/timeline/bounds';
import {
  playheadDeviationMs,
  seek,
  withinPlayheadTolerance,
} from '../../../domain/timeline/playhead';
import { anyTrackSoloed, renderTargetSet } from '../../../domain/timeline/render-target';
import { clip, projectWith } from '../../support/timeline-harness';

/**
 * Requirements 28.19 and 28.20 (which clips a mixdown renders) and 28.35 (the playhead).
 *
 * Both clauses of the first pair are written as `THE Mixdown_Renderer SHALL`, and the renderer is
 * task 4.2's. The *selection* is made entirely from solo and mute state task 4.1 owns, so it lives
 * in `domain/timeline/render-target.ts` and is tested here; nothing in this file renders audio.
 */

function withTracks(
  clips: Parameters<typeof projectWith>[0],
  overrides: Record<number, { muted?: boolean; solo?: boolean }>,
) {
  const project = projectWith(clips);
  return {
    ...project,
    tracks: project.tracks.map((track, index) => ({ ...track, ...(overrides[index] ?? {}) })),
  };
}

const clips = [
  clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
  clip({ id: 'b', track: 1, startTimeMs: 0, sourceDurationMs: 1_000 }),
  clip({ id: 'c', track: 2, startTimeMs: 0, sourceDurationMs: 1_000 }),
];

describe('render target selection (Requirements 28.19, 28.20)', () => {
  it('includes every unmuted clip when nothing is soloed', () => {
    const set = renderTargetSet(projectWith(clips));
    expect(set.soloActive).toBe(false);
    expect(set.clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(set.excluded).toEqual([]);
  });

  it('excludes a muted clip', () => {
    const project = projectWith([...clips.slice(1), clip({ id: 'a', track: 0, muted: true })]);
    const set = renderTargetSet(project);
    expect(set.clips.map((c) => c.id)).not.toContain('a');
    expect(set.excluded).toContainEqual({ clipId: 'a', reason: 'clip_muted' });
  });

  it('excludes every clip on a muted track', () => {
    const set = renderTargetSet(withTracks(clips, { 1: { muted: true } }));
    expect(set.clips.map((c) => c.id)).toEqual(['a', 'c']);
    expect(set.excluded).toContainEqual({ clipId: 'b', reason: 'track_muted' });
  });

  it('keeps only soloed tracks while any track is soloed', () => {
    const set = renderTargetSet(withTracks(clips, { 2: { solo: true } }));
    expect(anyTrackSoloed(withTracks(clips, { 2: { solo: true } }))).toBe(true);
    expect(set.clips.map((c) => c.id)).toEqual(['c']);
    expect(set.excluded).toContainEqual({ clipId: 'a', reason: 'not_soloed' });
  });

  it('lets mute win over solo on the same track (Requirement 28.20)', () => {
    // The clause settles this explicitly: 음소거를 우선 적용하여 제외한다.
    const set = renderTargetSet(withTracks(clips, { 0: { solo: true, muted: true } }));
    expect(set.clips).toEqual([]);
    expect(set.excluded).toContainEqual({ clipId: 'a', reason: 'track_muted' });
  });

  it('keeps the other soloed track when one soloed track is muted', () => {
    const set = renderTargetSet(
      withTracks(clips, { 0: { solo: true, muted: true }, 1: { solo: true } }),
    );
    expect(set.clips.map((c) => c.id)).toEqual(['b']);
  });

  it('excludes a muted clip on a soloed track', () => {
    const project = withTracks(
      [clip({ id: 'a', track: 0, muted: true }), clips[1]!],
      { 0: { solo: true } },
    );
    expect(renderTargetSet(project).clips).toEqual([]);
  });

  it('preserves clip order, which task 4.2\'s commutativity property depends on', () => {
    const set = renderTargetSet(projectWith([clips[2]!, clips[0]!, clips[1]!]));
    expect(set.clips.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('reports an empty target set rather than throwing, so Requirement 28.29 can decide', () => {
    const set = renderTargetSet(withTracks(clips, { 0: { muted: true }, 1: { muted: true }, 2: { muted: true } }));
    expect(set.clips).toEqual([]);
    expect(set.excluded).toHaveLength(3);
  });
});

describe('the playhead (Requirement 28.35)', () => {
  it('gives every track the same position, so the deviation is zero', () => {
    const position = seek(12_345);
    expect(position.trackPositionsMs).toHaveLength(TRACK_COUNT);
    expect(playheadDeviationMs(position, 12_345)).toBe(0);
    expect(withinPlayheadTolerance(position, 12_345)).toBe(true);
    expect(PLAYHEAD_TOLERANCE_MS).toBe(20);
  });

  it('clamps a negative request to zero, since Requirement 28.3 has no negative times', () => {
    expect(seek(-500).positionMs).toBe(0);
  });

  it('rounds to an integer millisecond', () => {
    expect(seek(1_000.6).positionMs).toBe(1_001);
  });

  it('refuses a measured position that drifted past the budget', () => {
    const drifted = { positionMs: 1_000, trackPositionsMs: [1_000, 1_021] };
    expect(withinPlayheadTolerance(drifted, 1_000)).toBe(false);
  });
});
