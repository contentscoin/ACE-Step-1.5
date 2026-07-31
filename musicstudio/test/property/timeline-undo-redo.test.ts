import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AUTO_PLACEMENT_GAP_MS, SNAP_WINDOW_MS, fadeCeilingMs } from '../../domain/timeline/bounds';
import {
  EDIT_COMMAND_TYPES,
  commandHandle,
  executeCommand,
  planAddClip,
  planClipFades,
  planClipGain,
  planClipMute,
  planDeleteClip,
  planDuplicateClip,
  planMoveClip,
  planSplitClip,
  planTrackPan,
  planTrackSolo,
  planTrackVolume,
  planTrimClip,
  type EditCommand,
  type EditCommandType,
  type EditPlan,
} from '../../domain/timeline/commands';
import {
  equivalenceReason,
  timelineProjectsEquivalent,
} from '../../domain/timeline/equivalence';
import { createHistory, record, redo, undo } from '../../domain/timeline/history';
import {
  clipEndTimeMs,
  clipPlayLengthMs,
  isValidTimelineProject,
  type TimelineProject,
} from '../../domain/timeline/project';
import {
  clipGainArbitrary,
  trackPanArbitrary,
  trackVolumeArbitrary,
  validProject,
} from '../support/timeline-harness';

/**
 * Properties 16 and 17 of design §10 — the undo/redo round trip and the undo inverse.
 *
 * Task 4.1 owns Properties 6, 7, 16 and 17 (tasks.md §9.2's ownership table); 6 and 7 are in
 * `timeline-project.test.ts`. Anything else asserted here is labelled **unnumbered** so task 9.2's
 * audit does not miscount it.
 *
 * ### One test per operation, not one test over a union of operations
 *
 * Task 4.1's acceptance criterion is "12개 편집 조작 **각각** 되돌리기→다시 실행 왕복 PBT 통과" —
 * each of the twelve, individually. A single property over `fc.oneof` of twelve generators would
 * satisfy the letter of "100 runs" while giving each operation about eight, and would report a
 * failure as "the undo property is broken" rather than as "the trim inverse is broken". So
 * `PLANNERS` below holds one generator per `EditCommandType` and each is asserted at 100 runs in
 * its own `it`, twice — once for Property 16 and once for Property 17. The exhaustiveness of the
 * mapping is itself asserted, so a thirteenth command type cannot be added without a test for it.
 *
 * ### The generators produce operations that *succeed*
 *
 * Both properties are quantified over "편집 조작 1건이 성공한 직후" — immediately after a
 * *successful* operation. A generator that proposed rejected edits would spend its runs on inputs
 * the properties say nothing about, and `fc.pre` would hide how many. So each generator is built to
 * land in the valid space:
 *
 * - **move** targets `trackEnd + gap` with `gap >= SNAP_WINDOW_MS`, so that even with snapping on
 *   (Requirement 28.21 may pull the clip up to 50 ms earlier) the destination cannot collide with
 *   anything already on that track;
 * - **trim** only ever shortens — both trims are generated at or above their current values — since
 *   a longer play length could run into the next clip on the track and Requirement 28.8 would
 *   rightly refuse it;
 * - **duplicate** picks a clip that is last on its track, so the copy's placement 200 ms past its
 *   end (Requirement 28.15) is free;
 * - **add** omits the start time, which puts the clip 200 ms past *everything* (Requirement 28.6).
 *
 * Each `it` still asserts `plan.ok`, so a generator that drifted out of the valid space fails
 * loudly instead of quietly testing nothing.
 */

interface PlannedEdit {
  readonly project: TimelineProject;
  readonly plan: EditPlan;
  /**
   * The clip the generator chose, when a test needs to identify it afterwards.
   *
   * Reported by the generator rather than recovered from the project, because generated clips
   * legitimately share asset ids and tracks — recovering "the clip this was copied from" by
   * matching fields finds the first match, not the right one.
   */
  readonly subjectClipId?: string;
}

/** A project with at least one clip, which every clip-level operation needs. */
function withClips(min = 1, max = 5): fc.Arbitrary<TimelineProject> {
  return validProject({ minClips: min, maxClips: max });
}

function pickClipIndex(project: TimelineProject, pick: number): number {
  return pick % project.clips.length;
}

/** The largest end time on `track`, or 0. Used to place a guaranteed-free destination. */
function trackEndMs(project: TimelineProject, track: number): number {
  return project.clips
    .filter((clip) => clip.track === track)
    .reduce((latest, clip) => Math.max(latest, clipEndTimeMs(clip)), 0);
}

const PLANNERS: Record<EditCommandType, fc.Arbitrary<PlannedEdit>> = {
  /* 1. 클립 추가 — Requirements 28.2, 28.5, 28.6. */
  clip_add: fc
    .record({
      project: validProject({ maxClips: 4 }),
      track: fc.integer({ min: 0, max: 31 }),
      sourceDurationMs: fc.integer({ min: 100, max: 20_000 }),
      gainDb: clipGainArbitrary(),
      muted: fc.boolean(),
    })
    .map(({ project, ...request }) => ({
      project,
      // No `startTimeMs`, so Requirement 28.6 places it past everything and no overlap is possible.
      plan: planAddClip(project, {
        clipId: 'clip-new',
        assetId: 'asset-0',
        sourceDurationMs: request.sourceDurationMs,
        track: request.track,
        gainDb: request.gainDb,
        muted: request.muted,
      }),
    })),

  /* 2. 클립 이동 — Requirements 28.7, 28.8, 28.21. */
  clip_move: fc
    .record({
      project: withClips(),
      pick: fc.nat(),
      destination: fc.integer({ min: 0, max: 31 }),
      gapMs: fc.integer({ min: SNAP_WINDOW_MS, max: 6_000 }),
      snapEnabled: fc.boolean(),
    })
    .map(({ project, pick, destination, gapMs, snapEnabled }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      // Free by construction: past the end of everything already on the destination track, and by
      // at least the snap window so Requirement 28.21 cannot pull it into a collision.
      const startTimeMs = trackEndMs(project, destination) + gapMs;
      return {
        project,
        plan: planMoveClip(project, {
          clipId: clip.id,
          startTimeMs,
          track: destination,
          snapEnabled,
        }),
      };
    }),

  /* 3. 트리밍 — Requirements 28.10, 28.11, 28.13, 28.17. */
  clip_trim: fc
    .record({
      project: withClips(),
      pick: fc.nat(),
      extraStart: fc.nat({ max: 5_000 }),
      extraEnd: fc.nat({ max: 5_000 }),
    })
    .map(({ project, pick, extraStart, extraEnd }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      // Only shortens; see the header. The remaining play length is kept at 1 ms or more, which is
      // what Requirement 28.10's strict inequality demands.
      const room = clipPlayLengthMs(clip) - 1;
      const addStart = Math.min(extraStart, room);
      const addEnd = Math.min(extraEnd, room - addStart);
      return {
        project,
        plan: planTrimClip(project, {
          clipId: clip.id,
          trimStartMs: clip.trimStartMs + addStart,
          trimEndMs: clip.trimEndMs + addEnd,
        }),
      };
    }),

  /* 4. 분할 — Requirement 28.14. */
  clip_split: fc
    .record({ project: withClips(), pick: fc.nat(), where: fc.nat() })
    .map(({ project, pick, where }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      const playLength = clipPlayLengthMs(clip);
      // A cut strictly inside, so both halves keep at least a millisecond. Clips with a play
      // length of 1 ms cannot be split at all and are moved off by one, which keeps the generator
      // total rather than making it reject.
      const offset = playLength < 2 ? 1 : 1 + (where % (playLength - 1));
      return {
        project,
        plan: planSplitClip(project, {
          clipId: clip.id,
          atMs: clip.startTimeMs + offset,
          leftClipId: 'clip-left',
          rightClipId: 'clip-right',
        }),
      };
    })
    // The 1 ms clip is the one case the offset arithmetic cannot serve; excluding it here keeps
    // every remaining run a *successful* operation, which is what 28.23 quantifies over.
    .filter(({ plan }) => plan.ok),

  /* 5. 복제 — Requirement 28.15. */
  clip_duplicate: fc
    .record({ project: withClips(), pick: fc.nat() })
    .map(({ project, pick }) => {
      // The clip that is last on its track, so the copy's placement 200 ms past its end is free.
      const lastOnTrack = project.clips.filter(
        (clip) => clipEndTimeMs(clip) === trackEndMs(project, clip.track),
      );
      const clip = lastOnTrack[pick % Math.max(1, lastOnTrack.length)];
      if (clip === undefined) throw new Error('generator produced no clip');
      return {
        project,
        plan: planDuplicateClip(project, { clipId: clip.id, newClipId: 'clip-copy' }),
        subjectClipId: clip.id,
      };
    }),

  /* 6. 삭제. */
  clip_delete: fc
    .record({ project: withClips(), pick: fc.nat() })
    .map(({ project, pick }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      return { project, plan: planDeleteClip(project, clip.id) };
    }),

  /* 7. 클립 게인 변경 — Requirement 28.16. */
  clip_gain: fc
    .record({ project: withClips(), pick: fc.nat(), gainDb: clipGainArbitrary() })
    .map(({ project, pick, gainDb }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      return { project, plan: planClipGain(project, clip.id, gainDb) };
    }),

  /* 8. 페이드 변경 — Requirement 28.17. */
  clip_fade: fc
    .record({
      project: withClips(),
      pick: fc.nat(),
      inRatio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      outRatio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    })
    .map(({ project, pick, inRatio, outRatio }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      const ceiling = fadeCeilingMs(clipPlayLengthMs(clip));
      return {
        project,
        plan: planClipFades(project, clip.id, {
          fadeInMs: Math.floor(ceiling * inRatio),
          fadeOutMs: Math.floor(ceiling * outRatio),
        }),
      };
    }),

  /* 9. 클립 음소거 전환. */
  clip_mute: fc
    .record({ project: withClips(), pick: fc.nat() })
    .map(({ project, pick }) => {
      const clip = project.clips[pickClipIndex(project, pick)];
      if (clip === undefined) throw new Error('generator produced no clip');
      return { project, plan: planClipMute(project, clip.id) };
    }),

  /* 10. 트랙 음량 변경 — Requirement 28.18. */
  track_volume: fc
    .record({
      project: validProject(),
      track: fc.integer({ min: 0, max: 31 }),
      volumeDb: trackVolumeArbitrary(),
    })
    .map(({ project, track, volumeDb }) => ({
      project,
      plan: planTrackVolume(project, track, volumeDb),
    })),

  /* 11. 트랙 팬 변경 — Requirement 28.18. */
  track_pan: fc
    .record({
      project: validProject(),
      track: fc.integer({ min: 0, max: 31 }),
      pan: trackPanArbitrary(),
    })
    .map(({ project, track, pan }) => ({ project, plan: planTrackPan(project, track, pan) })),

  /* 12. 트랙 솔로 전환 — Requirement 28.19. */
  track_solo: fc
    .record({ project: validProject(), track: fc.integer({ min: 0, max: 31 }) })
    .map(({ project, track }) => ({ project, plan: planTrackSolo(project, track) })),
};

/** Requirement 28.23's twelve, as the labels the tests are named with. */
const OPERATION_LABELS: Record<EditCommandType, string> = {
  clip_add: '1. 클립 추가 (add)',
  clip_move: '2. 클립 이동 (move)',
  clip_trim: '3. 트리밍 (trim)',
  clip_split: '4. 분할 (split)',
  clip_duplicate: '5. 복제 (duplicate)',
  clip_delete: '6. 삭제 (delete)',
  clip_gain: '7. 클립 게인 변경 (clip gain)',
  clip_fade: '8. 페이드 변경 (fade)',
  clip_mute: '9. 클립 음소거 전환 (clip mute)',
  track_volume: '10. 트랙 음량 변경 (track volume)',
  track_pan: '11. 트랙 팬 변경 (track pan)',
  track_solo: '12. 트랙 솔로 전환 (track solo)',
};

function assertPlanned(plan: EditPlan, type: EditCommandType): EditCommand {
  expect(plan.ok, `generator produced a rejected ${type} plan`).toBe(true);
  if (!plan.ok) throw new Error('unreachable');
  expect(plan.command.type).toBe(type);
  return plan.command;
}

describe('Feature: ai-music-generation-service, Property 16: undo/redo round-trip', () => {
  /**
   * Feature: ai-music-generation-service, Property 16: For any single successful edit operation,
   * performing one undo followed by one redo yields a project equivalent, under the project
   * equivalence relation, to the state immediately after the operation.
   *
   * **Validates: Requirements 28.23**
   *
   * One test per operation — see the file header. The whole cycle goes through `EditHistory`, so the
   * property covers Requirement 28.22's bookkeeping (the undone command becomes redoable) as well
   * as the commands themselves.
   */
  for (const type of EDIT_COMMAND_TYPES) {
    it(`round-trips ${OPERATION_LABELS[type]} through undo then redo`, async () => {
      await fc.assert(
        fc.asyncProperty(PLANNERS[type], async ({ project, plan }) => {
          const command = assertPlanned(plan, type);

          const afterExecute = executeCommand(project, command);
          const history = record(createHistory(), command);
          // The operation must leave a valid project, or the property would be asserting an
          // equivalence between two states the product should never hold.
          expect(isValidTimelineProject(afterExecute)).toBe(true);

          const undone = undo(afterExecute, history);
          expect(undone.ok).toBe(true);
          if (!undone.ok) return;

          const redone = redo(undone.project, undone.history);
          expect(redone.ok).toBe(true);
          if (!redone.ok) return;

          const verdict = timelineProjectsEquivalent(afterExecute, redone.project);
          expect(verdict.equivalent, equivalenceReason(verdict)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  }
});

describe('Feature: ai-music-generation-service, Property 17: undo inverse', () => {
  /**
   * Feature: ai-music-generation-service, Property 17: For any single successful edit operation,
   * performing one undo yields a project equivalent, under the project equivalence relation, to the
   * state immediately before the operation.
   *
   * **Validates: Requirements 28.37**
   */
  for (const type of EDIT_COMMAND_TYPES) {
    it(`inverts ${OPERATION_LABELS[type]} on undo`, async () => {
      await fc.assert(
        fc.asyncProperty(PLANNERS[type], async ({ project, plan }) => {
          const command = assertPlanned(plan, type);

          const afterExecute = executeCommand(project, command);
          const undone = undo(afterExecute, record(createHistory(), command));
          expect(undone.ok).toBe(true);
          if (!undone.ok) return;

          const verdict = timelineProjectsEquivalent(project, undone.project);
          expect(verdict.equivalent, equivalenceReason(verdict)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  }
});

describe('unnumbered undo/redo invariants', () => {
  /**
   * Unnumbered. Design §10 numbers no property for the mapping's completeness, but both properties
   * above are only as complete as `PLANNERS`, and Requirement 28.23's list of twelve is the thing
   * task 4.1's acceptance criterion counts. A thirteenth command type added to design §6.4 without
   * a generator here would silently reduce the coverage rather than fail.
   */
  it('covers exactly the twelve operations Requirement 28.23 enumerates', () => {
    expect(Object.keys(PLANNERS).sort()).toEqual([...EDIT_COMMAND_TYPES].sort());
    expect(Object.keys(OPERATION_LABELS).sort()).toEqual([...EDIT_COMMAND_TYPES].sort());
    expect(EDIT_COMMAND_TYPES).toHaveLength(12);
  });

  /**
   * Unnumbered. Design §6.4 states the command interface with `execute` and `undo` methods; the
   * records here are the stored form and `commandHandle` is the view over them. This pins that the
   * two agree, so a caller that prefers §6.4's shape gets the same behaviour the properties proved.
   */
  it('agrees between the record form and design §6.4\'s handle form', async () => {
    await fc.assert(
      fc.asyncProperty(PLANNERS.clip_move, async ({ project, plan }) => {
        const command = assertPlanned(plan, 'clip_move');
        const handle = commandHandle(command);

        expect(handle.type).toBe(command.type);
        const viaHandle = handle.undo(handle.execute(project));
        const viaRecord = undo(executeCommand(project, command), record(createHistory(), command));
        expect(viaRecord.ok).toBe(true);
        if (!viaRecord.ok) return;
        expect(timelineProjectsEquivalent(viaHandle, viaRecord.project).equivalent).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Unnumbered. Requirement 28.15's placement, asserted as a property because it is the one
   * operation whose *result position* the clause fixes numerically rather than leaving to the
   * request.
   */
  it('places a duplicate exactly 200 ms after the original ends', async () => {
    await fc.assert(
      fc.asyncProperty(PLANNERS.clip_duplicate, async ({ project, plan, subjectClipId }) => {
        const command = assertPlanned(plan, 'clip_duplicate');
        if (command.type !== 'clip_duplicate') return;

        const original = project.clips.find((clip) => clip.id === subjectClipId);
        expect(original).toBeDefined();
        if (original === undefined) return;

        // Trim, gain and fade values are preserved (28.15), and only the id and start time differ.
        expect(command.clip.trimStartMs).toBe(original.trimStartMs);
        expect(command.clip.trimEndMs).toBe(original.trimEndMs);
        expect(command.clip.gainDb).toBe(original.gainDb);
        expect(command.clip.fadeInMs).toBe(original.fadeInMs);
        expect(command.clip.fadeOutMs).toBe(original.fadeOutMs);
        expect(command.clip.startTimeMs).toBe(clipEndTimeMs(original) + AUTO_PLACEMENT_GAP_MS);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Unnumbered. Requirement 28.14's length invariant: the two halves' play lengths sum to the
   * original's. Asserted here as well as in `test/unit/timeline/clip-operations.test.ts` because it
   * is the one arithmetic claim in Requirement 28 that a rounding change could break silently.
   */
  it('splits without changing the total play length', async () => {
    await fc.assert(
      fc.asyncProperty(PLANNERS.clip_split, async ({ plan }) => {
        const command = assertPlanned(plan, 'clip_split');
        if (command.type !== 'clip_split') return;
        expect(clipPlayLengthMs(command.left) + clipPlayLengthMs(command.right)).toBe(
          clipPlayLengthMs(command.original),
        );
      }),
      { numRuns: 100 },
    );
  });
});
