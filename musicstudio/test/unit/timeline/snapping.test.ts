import { describe, expect, it } from 'vitest';

import { SNAP_WINDOW_MS, barLengthMs } from '../../../domain/timeline/bounds';
import { planMoveClip } from '../../../domain/timeline/commands';
import {
  resolveSnappedStartTime,
  snapCandidates,
} from '../../../domain/timeline/snapping';
import { clip, projectWith } from '../../support/timeline-harness';

/**
 * Requirement 28.21's snap rule and Requirement 28.39's condition on it.
 *
 * Example-based rather than property-based: the clause is a sequence of tie-breaks and boundary
 * cases, and each of them is one specific arrangement. Design §10 numbers no property for snapping.
 */

const base = projectWith([
  clip({ id: 'a', track: 0, startTimeMs: 1_000, sourceDurationMs: 2_000 }),
  clip({ id: 'moving', track: 1, startTimeMs: 20_000, sourceDurationMs: 1_000 }),
]);

function snapped(requestedMs: number, project = base): number {
  return resolveSnappedStartTime(project, requestedMs, {
    enabled: true,
    movingClipId: 'moving',
  }).startTimeMs;
}

describe('snap candidates (Requirement 28.21)', () => {
  it('offers the start and end of every other clip', () => {
    const candidates = snapCandidates(base, 1_000, 'moving');
    expect(candidates.filter((c) => c.kind === 'clip_start').map((c) => c.timeMs)).toEqual([1_000]);
    expect(candidates.filter((c) => c.kind === 'clip_end').map((c) => c.timeMs)).toEqual([3_000]);
  });

  it('never offers the moving clip\'s own edges', () => {
    const candidates = snapCandidates(base, 20_000, 'moving');
    expect(candidates.map((c) => c.clipId)).not.toContain('moving');
  });

  it('offers clips on other tracks, since Requirement 28.21 does not qualify 인접 by track', () => {
    // `a` is on track 0 and the moving clip is on track 1; lining a sound effect up against the
    // music it hits is the main use of the feature.
    expect(snapCandidates(base, 1_000, 'moving').some((c) => c.clipId === 'a')).toBe(true);
  });

  it('offers no bar boundary when the tempo is unset (Requirements 28.21, 28.39)', () => {
    expect(snapCandidates(base, 5_000, 'moving').filter((c) => c.kind === 'bar_boundary')).toEqual(
      [],
    );
  });

  it('offers no bar boundary when the time signature is unset', () => {
    const project = { ...base, tempoBpm: 120, timeSignature: null };
    expect(
      snapCandidates(project, 5_000, 'moving').filter((c) => c.kind === 'bar_boundary'),
    ).toEqual([]);
  });

  it('offers the bar at or before the request and the one after', () => {
    // 120 BPM in 4/4: a beat is 500 ms and a bar is 2 000 ms.
    const project = { ...base, tempoBpm: 120, timeSignature: 4 };
    expect(barLengthMs(120, 4)).toBe(2_000);
    const bars = snapCandidates(project, 5_100, 'moving')
      .filter((c) => c.kind === 'bar_boundary')
      .map((c) => c.timeMs);
    expect(bars).toEqual([4_000, 6_000]);
  });

  it('rounds each bar from its own multiple, not from a rounded bar length', () => {
    // 130 BPM in 3/4: a bar is 1384.615… ms. Bar 100 is at 138 462 ms, which a rounded bar length
    // of 1385 ms would put at 138 500 — 38 ms away, most of the snap window.
    const project = { ...base, tempoBpm: 130, timeSignature: 3 };
    const bars = snapCandidates(project, 138_462, 'moving').filter((c) => c.kind === 'bar_boundary');
    expect(bars.map((c) => c.timeMs)).toContain(138_462);
  });

  it('never offers a negative time', () => {
    const project = { ...base, tempoBpm: 120, timeSignature: 4 };
    expect(snapCandidates(project, 0, 'moving').every((c) => c.timeMs >= 0)).toBe(true);
  });
});

describe('snap selection (Requirement 28.21)', () => {
  it('snaps to a candidate exactly 50 ms away, since the window is inclusive', () => {
    expect(snapped(1_050)).toBe(1_000);
    expect(snapped(950)).toBe(1_000);
  });

  it('leaves a request 51 ms away untouched', () => {
    expect(snapped(1_051)).toBe(1_051);
    expect(SNAP_WINDOW_MS).toBe(50);
  });

  it('chooses the nearest candidate', () => {
    // 2 980 is 20 ms from the clip end at 3 000 and 1 980 ms from its start at 1 000.
    expect(snapped(2_980)).toBe(3_000);
  });

  it('breaks a tie towards the earlier time', () => {
    // Two clips 100 ms apart; a request exactly between their facing edges is 50 ms from each.
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
      clip({ id: 'b', track: 0, startTimeMs: 1_100, sourceDurationMs: 1_000 }),
      clip({ id: 'moving', track: 2, startTimeMs: 50_000, sourceDurationMs: 100 }),
    ]);
    // Candidates within 50 ms of 1 050: the end of `a` at 1 000 and the start of `b` at 1 100.
    expect(snapped(1_050, project)).toBe(1_000);
  });

  it('applies the requested time unchanged when nothing is in range', () => {
    const outcome = resolveSnappedStartTime(base, 50_000, {
      enabled: true,
      movingClipId: 'moving',
    });
    expect(outcome.startTimeMs).toBe(50_000);
    expect(outcome.candidate).toBeNull();
    expect(outcome.consideredCandidates).toEqual([]);
  });

  it('does nothing at all when snapping is off', () => {
    const outcome = resolveSnappedStartTime(base, 1_010, {
      enabled: false,
      movingClipId: 'moving',
    });
    expect(outcome.startTimeMs).toBe(1_010);
    expect(outcome.candidate).toBeNull();
  });

  it('reports which candidate won, for a UI that wants to say so', () => {
    const outcome = resolveSnappedStartTime(base, 2_990, {
      enabled: true,
      movingClipId: 'moving',
    });
    expect(outcome.candidate?.kind).toBe('clip_end');
    expect(outcome.candidate?.clipId).toBe('a');
  });
});

describe('a snapped move is the move that is applied and the move that is undone', () => {
  it('records the snapped time, not the requested one', () => {
    // This is why `commands.ts` captures the before/after placement instead of recomputing a
    // delta: the delta the user asked for is not the delta that was applied.
    const plan = planMoveClip(base, { clipId: 'moving', startTimeMs: 1_010, snapEnabled: true });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_move') return;
    expect(plan.command.after.startTimeMs).toBe(1_000);
    expect(plan.command.before.startTimeMs).toBe(20_000);
    expect(plan.command.snappedTo?.kind).toBe('clip_start');
  });

  it('does not snap when the caller did not ask for it', () => {
    const plan = planMoveClip(base, { clipId: 'moving', startTimeMs: 1_010 });
    if (!plan.ok || plan.command.type !== 'clip_move') throw new Error('move rejected');
    expect(plan.command.after.startTimeMs).toBe(1_010);
    expect(plan.command.snappedTo).toBeNull();
  });
});
