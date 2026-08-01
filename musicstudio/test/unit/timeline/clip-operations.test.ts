import { describe, expect, it } from 'vitest';

import {
  AUTO_PLACEMENT_GAP_MS,
  PROJECT_CLIP_COUNT_MAX,
  fadeCeilingMs,
} from '../../../domain/timeline/bounds';
import {
  executeCommand,
  planAddClip,
  planClipFades,
  planClipGain,
  planDeleteClip,
  planDuplicateClip,
  planMoveClip,
  planSplitClip,
  planTrimClip,
} from '../../../domain/timeline/commands';
import {
  clipPlayLengthMs,
  isValidTimelineProject,
  overlapMs,
  projectViolations,
} from '../../../domain/timeline/project';
import { clip, effectChain, projectWith } from '../../support/timeline-harness';

/**
 * The clip operations of Requirement 28, by example.
 *
 * The property suites in `test/property/` prove the undo/redo algebra over the twelve operations;
 * these are the specific numbers and rejections the clauses state, which a property quantified over
 * successful operations would never reach — the 501st clip, the over-trim, the collision.
 */

function violationCodes(plan: ReturnType<typeof planAddClip>): string[] {
  return plan.ok ? [] : plan.violations.map((violation) => violation.violation);
}

describe('adding a clip (Requirements 28.2, 28.5, 28.6, 28.8)', () => {
  it('starts the first clip at 0 when no start time is given', () => {
    const plan = planAddClip(projectWith([]), {
      clipId: 'a',
      assetId: 'asset-0',
      sourceDurationMs: 5_000,
      track: 3,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.command.type).toBe('clip_add');
    if (plan.command.type !== 'clip_add') return;
    expect(plan.command.clip.startTimeMs).toBe(0);
  });

  it('places a later clip 200 ms after the latest end across every track', () => {
    // Requirement 28.6 says 기존 클립들의 최대 종료 시각 without qualifying by track, so a clip on
    // track 5 is placed after material on track 0.
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
      clip({ id: 'b', track: 1, startTimeMs: 4_000, sourceDurationMs: 2_000 }),
    ]);

    const plan = planAddClip(project, {
      clipId: 'c',
      assetId: 'asset-0',
      sourceDurationMs: 500,
      track: 5,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_add') return;
    expect(plan.command.clip.startTimeMs).toBe(6_000 + AUTO_PLACEMENT_GAP_MS);
  });

  it('refuses the 501st clip, reporting the current count and the ceiling of 500', () => {
    // The clips are laid end to end on one track so the project is genuinely valid at 500.
    const clips = Array.from({ length: PROJECT_CLIP_COUNT_MAX }, (_unused, index) =>
      clip({ id: `c${String(index)}`, startTimeMs: index * 1_000, sourceDurationMs: 900 }),
    );
    const project = projectWith(clips);
    expect(isValidTimelineProject(project)).toBe(true);

    const plan = planAddClip(project, {
      clipId: 'overflow',
      assetId: 'asset-0',
      sourceDurationMs: 500,
      track: 4,
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    const fault = plan.violations.find((v) => v.violation === 'clip_count_exceeded');
    // Requirement 28.5 asks for both numbers.
    expect(fault?.actual).toBe(String(PROJECT_CLIP_COUNT_MAX));
    expect(fault?.expected).toBe(String(PROJECT_CLIP_COUNT_MAX));
  });

  it('accepts a project holding exactly 500 clips', () => {
    const clips = Array.from({ length: PROJECT_CLIP_COUNT_MAX }, (_unused, index) =>
      clip({ id: `c${String(index)}`, startTimeMs: index * 1_000, sourceDurationMs: 900 }),
    );
    expect(projectViolations(projectWith(clips))).toEqual([]);
  });

  it('rejects the 501st clip as stored state, not only as a request', () => {
    const clips = Array.from({ length: PROJECT_CLIP_COUNT_MAX + 1 }, (_unused, index) =>
      clip({ id: `c${String(index)}`, startTimeMs: index * 1_000, sourceDurationMs: 900 }),
    );
    expect(
      projectViolations(projectWith(clips)).map((v) => v.violation),
    ).toContain('clip_count_exceeded');
  });

  it('reports the conflicting clip and the overlap length on a collision', () => {
    const project = projectWith([
      clip({ id: 'a', track: 2, startTimeMs: 1_000, sourceDurationMs: 1_000 }),
    ]);

    const plan = planAddClip(project, {
      clipId: 'b',
      assetId: 'asset-0',
      sourceDurationMs: 1_000,
      track: 2,
      startTimeMs: 1_600,
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.overlaps).toHaveLength(1);
    expect(plan.overlaps[0]?.otherClipId).toBe('a');
    // [1000,2000) against [1600,2600) is 400 ms.
    expect(plan.overlaps[0]?.overlapMs).toBe(400);
  });

  it('allows a clip that starts exactly where another ends', () => {
    // Requirement 28.7 forbids overlapping *playback intervals*; touching edges never sound
    // simultaneously, so the interval is half-open.
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
    ]);
    expect(overlapMs(project.clips[0]!, clip({ id: 'b', startTimeMs: 1_000 }))).toBe(0);

    const plan = planAddClip(project, {
      clipId: 'b',
      assetId: 'asset-0',
      sourceDurationMs: 500,
      track: 0,
      startTimeMs: 1_000,
    });
    expect(plan.ok).toBe(true);
  });

  it('allows overlapping clips on different tracks', () => {
    // Requirement 28.9: different tracks are summed, not refused.
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 5_000 }),
    ]);
    const plan = planAddClip(project, {
      clipId: 'b',
      assetId: 'asset-0',
      sourceDurationMs: 5_000,
      track: 1,
      startTimeMs: 0,
    });
    expect(plan.ok).toBe(true);
  });
});

describe('trimming (Requirements 28.10, 28.11, 28.12, 28.13, 28.17)', () => {
  const project = projectWith([
    clip({ id: 'a', sourceDurationMs: 10_000, fadeInMs: 2_000, fadeOutMs: 2_000 }),
  ]);

  it('keeps play length equal to source minus both trims', () => {
    const plan = planTrimClip(project, { clipId: 'a', trimStartMs: 1_500, trimEndMs: 500 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const next = executeCommand(project, plan.command);
    expect(clipPlayLengthMs(next.clips[0]!)).toBe(8_000);
    // Requirement 28.12: the asset itself is untouched, which for a value type means the source
    // duration is unchanged.
    expect(next.clips[0]?.sourceDurationMs).toBe(10_000);
  });

  it('rejects trims that consume the whole asset, reporting the largest permitted sum', () => {
    const plan = planTrimClip(project, { clipId: 'a', trimStartMs: 5_000, trimEndMs: 5_000 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    const fault = plan.violations.find((v) => v.violation === 'clip_trim_exceeds_source');
    // Requirement 28.11's 허용 최대 트림 값: 10 000 − 1.
    expect(fault?.expected).toBe('9999');
    expect(fault?.actual).toBe('10000');
  });

  it('clamps fades that a shortened play length would make illegal, and restores them on undo', () => {
    // The clip has 2 000 ms fades and a 10 000 ms play length. Trimming to 2 000 ms puts the
    // Requirement 28.17 ceiling at 1 000 ms.
    const plan = planTrimClip(project, { clipId: 'a', trimStartMs: 4_000, trimEndMs: 4_000 });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_trim') return;

    expect(fadeCeilingMs(2_000)).toBe(1_000);
    expect(plan.command.afterFades).toEqual({ fadeInMs: 1_000, fadeOutMs: 1_000 });
    // The command carries the *original* fades, so the inverse restores 2 000 rather than 1 000.
    expect(plan.command.beforeFades).toEqual({ fadeInMs: 2_000, fadeOutMs: 2_000 });

    const next = executeCommand(project, plan.command);
    expect(isValidTimelineProject(next)).toBe(true);
  });

  it('rejects a negative or fractional trim', () => {
    expect(
      violationCodes(planTrimClip(project, { clipId: 'a', trimStartMs: -1, trimEndMs: 0 })),
    ).toContain('clip_trim_invalid');
    expect(
      violationCodes(planTrimClip(project, { clipId: 'a', trimStartMs: 1.5, trimEndMs: 0 })),
    ).toContain('clip_trim_invalid');
  });
});

describe('splitting (Requirement 28.14)', () => {
  const project = projectWith([
    clip({
      id: 'a',
      sourceDurationMs: 10_000,
      startTimeMs: 1_000,
      trimStartMs: 1_000,
      trimEndMs: 1_000,
      fadeInMs: 500,
      fadeOutMs: 500,
    }),
  ]);

  it('produces two clips over the same asset whose play lengths sum to the original', () => {
    const plan = planSplitClip(project, {
      clipId: 'a',
      atMs: 4_000,
      leftClipId: 'l',
      rightClipId: 'r',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_split') return;

    const { left, right, original } = plan.command;
    expect(left.assetId).toBe(original.assetId);
    expect(right.assetId).toBe(original.assetId);
    expect(clipPlayLengthMs(left) + clipPlayLengthMs(right)).toBe(clipPlayLengthMs(original));
    // The right half starts at the cut and reads from where the left half stopped.
    expect(right.startTimeMs).toBe(4_000);
    expect(right.trimStartMs).toBe(original.trimStartMs + 3_000);

    const next = executeCommand(project, plan.command);
    expect(next.clips.map((c) => c.id)).toEqual(['l', 'r']);
    expect(isValidTimelineProject(next)).toBe(true);
  });

  it('puts no fade at the cut and keeps the outer fades', () => {
    const plan = planSplitClip(project, {
      clipId: 'a',
      atMs: 4_000,
      leftClipId: 'l',
      rightClipId: 'r',
    });
    if (!plan.ok || plan.command.type !== 'clip_split') throw new Error('split rejected');
    expect(plan.command.left.fadeInMs).toBe(500);
    expect(plan.command.left.fadeOutMs).toBe(0);
    expect(plan.command.right.fadeInMs).toBe(0);
    expect(plan.command.right.fadeOutMs).toBe(500);
  });

  it('refuses a cut at either edge, since a zero-length half is not a clip', () => {
    for (const atMs of [1_000, 9_000, 500, 12_000]) {
      expect(
        planSplitClip(project, { clipId: 'a', atMs, leftClipId: 'l', rightClipId: 'r' }).ok,
      ).toBe(false);
    }
  });
});

describe('duplicating (Requirement 28.15)', () => {
  it('preserves trim, gain and fade values and lands 200 ms after the original ends', () => {
    const project = projectWith([
      clip({
        id: 'a',
        track: 7,
        startTimeMs: 2_000,
        sourceDurationMs: 8_000,
        trimStartMs: 1_000,
        trimEndMs: 1_000,
        gainDb: -6.5,
        fadeInMs: 300,
        fadeOutMs: 400,
        muted: true,
      }),
    ]);

    const plan = planDuplicateClip(project, { clipId: 'a', newClipId: 'copy' });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_duplicate') return;

    const copy = plan.command.clip;
    expect(copy.track).toBe(7);
    expect(copy.trimStartMs).toBe(1_000);
    expect(copy.trimEndMs).toBe(1_000);
    expect(copy.gainDb).toBe(-6.5);
    expect(copy.fadeInMs).toBe(300);
    expect(copy.fadeOutMs).toBe(400);
    expect(copy.muted).toBe(true);
    // Original occupies [2000, 8000); the copy starts 200 ms later.
    expect(copy.startTimeMs).toBe(8_000 + AUTO_PLACEMENT_GAP_MS);
  });

  it('refuses a copy that would land on top of another clip', () => {
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
      clip({ id: 'b', track: 0, startTimeMs: 1_100, sourceDurationMs: 1_000 }),
    ]);
    const plan = planDuplicateClip(project, { clipId: 'a', newClipId: 'copy' });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.overlaps[0]?.otherClipId).toBe('b');
  });
});

describe('deleting and moving', () => {
  const project = projectWith([
    clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 1_000 }),
    clip({ id: 'b', track: 0, startTimeMs: 2_000, sourceDurationMs: 1_000 }),
    clip({ id: 'c', track: 1, startTimeMs: 0, sourceDurationMs: 1_000 }),
  ]);

  it('removes only the named clip and records its position', () => {
    const plan = planDeleteClip(project, 'b');
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_delete') return;
    expect(plan.command.index).toBe(1);
    expect(executeCommand(project, plan.command).clips.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('rejects an unknown clip id rather than silently doing nothing', () => {
    expect(planDeleteClip(project, 'nope').ok).toBe(false);
    expect(planMoveClip(project, { clipId: 'nope', startTimeMs: 0 }).ok).toBe(false);
  });

  it('moves a clip to another track when the destination is free', () => {
    const plan = planMoveClip(project, { clipId: 'a', startTimeMs: 5_000, track: 1 });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.command.type !== 'clip_move') return;
    expect(plan.command.before).toEqual({ startTimeMs: 0, track: 0 });
    expect(plan.command.after).toEqual({ startTimeMs: 5_000, track: 1 });
  });

  it('does not count a clip\'s own former placement as a collision', () => {
    // Moving `a` by 1 ms overlaps its old interval; the check must ignore the clip itself.
    const plan = planMoveClip(project, { clipId: 'a', startTimeMs: 1 });
    expect(plan.ok).toBe(true);
  });
});

describe('gain and fade bounds (Requirements 28.16, 28.17)', () => {
  const project = projectWith([clip({ id: 'a', sourceDurationMs: 10_000 })]);

  it('accepts the endpoints and refuses just outside them', () => {
    expect(planClipGain(project, 'a', -40).ok).toBe(true);
    expect(planClipGain(project, 'a', 12).ok).toBe(true);
    expect(violationCodes(planClipGain(project, 'a', -40.1))).toContain('clip_gain_range');
    expect(violationCodes(planClipGain(project, 'a', 12.1))).toContain('clip_gain_range');
  });

  it('caps each fade at half the play length', () => {
    expect(planClipFades(project, 'a', { fadeInMs: 5_000, fadeOutMs: 5_000 }).ok).toBe(true);
    expect(
      violationCodes(planClipFades(project, 'a', { fadeInMs: 5_001, fadeOutMs: 0 })),
    ).toContain('clip_fade_range');
    expect(
      violationCodes(planClipFades(project, 'a', { fadeInMs: 0, fadeOutMs: -1 })),
    ).toContain('clip_fade_range');
  });

  it('floors the ceiling for an odd play length, so a fade never exceeds half', () => {
    // 7 ms of play length: half is 3.5 ms, and rounding up would admit a fade longer than half.
    expect(fadeCeilingMs(7)).toBe(3);
    const odd = projectWith([clip({ id: 'a', sourceDurationMs: 7 })]);
    expect(planClipFades(odd, 'a', { fadeInMs: 3, fadeOutMs: 3 }).ok).toBe(true);
    expect(planClipFades(odd, 'a', { fadeInMs: 4, fadeOutMs: 0 }).ok).toBe(false);
  });
});


describe('a clip\'s Effect_Chain through the edit operations (Requirement 29.31)', () => {
  const chain = effectChain(['reverb']);

  it('is `null` for a clip added without one', () => {
    const plan = planAddClip(projectWith([]), {
      clipId: 'a',
      assetId: 'asset-0',
      sourceDurationMs: 4_000,
      track: 0,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const project = executeCommand(projectWith([]), plan.command);
    expect(project.clips[0]?.effectChain).toBeNull();
  });

  it('is stored when a clip is added with one', () => {
    // Requirement 28.23 lists twelve operations and none of them is "set a clip's chain", so this
    // is the one place an edit can attach one. See the note on `AddClipRequest` and the task 4.3
    // report's open questions.
    const plan = planAddClip(projectWith([]), {
      clipId: 'a',
      assetId: 'asset-0',
      sourceDurationMs: 4_000,
      track: 0,
      effectChain: chain,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const project = executeCommand(projectWith([]), plan.command);
    expect(project.clips[0]?.effectChain).toEqual(chain);
    expect(isValidTimelineProject(project)).toBe(true);
  });

  it('refuses a clip added with an invalid chain', () => {
    const plan = planAddClip(projectWith([]), {
      clipId: 'a',
      assetId: 'asset-0',
      sourceDurationMs: 4_000,
      track: 0,
      // Requirement 29.13's ceiling is 16 items.
      effectChain: { items: [] },
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.violations.map((violation) => violation.violation)).toContain(
      'clip_effect_chain_invalid',
    );
  });

  it('gives both halves of a split the original\'s chain', () => {
    // Each half is a clip over the same asset, and Requirement 29.31 makes a chain a per-clip
    // setting; giving it to one half would silently unprocess the other.
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 4_000, effectChain: chain }),
    ]);
    const plan = planSplitClip(project, { clipId: 'a', atMs: 2_000, leftClipId: 'l', rightClipId: 'r' });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const split = executeCommand(project, plan.command);
    expect(split.clips.map((c) => c.effectChain)).toEqual([chain, chain]);
  });

  it('gives a duplicate the original\'s chain', () => {
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 4_000, effectChain: chain }),
    ]);
    const plan = planDuplicateClip(project, { clipId: 'a', newClipId: 'a2' });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const duplicated = executeCommand(project, plan.command);
    expect(duplicated.clips[1]?.effectChain).toEqual(chain);
  });

  it('leaves the chain alone when a clip is moved, trimmed, re-gained or re-faded', () => {
    const project = projectWith([
      clip({ id: 'a', track: 0, startTimeMs: 1_000, sourceDurationMs: 4_000, effectChain: chain }),
    ]);

    const plans = [
      planMoveClip(project, { clipId: 'a', startTimeMs: 2_000 }),
      planTrimClip(project, { clipId: 'a', trimStartMs: 500, trimEndMs: 0 }),
      planClipGain(project, 'a', -6),
      planClipFades(project, 'a', { fadeInMs: 100, fadeOutMs: 0 }),
    ];

    for (const plan of plans) {
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      const edited = executeCommand(project, plan.command);
      expect(edited.clips[0]?.effectChain).toEqual(chain);
    }
  });
});
