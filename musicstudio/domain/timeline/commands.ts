/**
 * The twelve edit commands of Requirement 28.23 and design §6.4.
 *
 * Requirement 28.23 enumerates them, and design §6.4's `EditCommandType` repeats the same
 * twelve in the same order. Both lists are reproduced by `EDIT_COMMAND_TYPES` below so that a
 * thirteenth cannot be added here without the exhaustiveness check in
 * `test/property/timeline-undo-redo.test.ts` noticing:
 *
 * | # | Requirement 28.23 | `EditCommandType` |
 * |---|---|---|
 * | 1 | 클립 추가 | `clip_add` |
 * | 2 | 클립 이동 | `clip_move` |
 * | 3 | 트리밍 | `clip_trim` |
 * | 4 | 분할 | `clip_split` |
 * | 5 | 복제 | `clip_duplicate` |
 * | 6 | 삭제 | `clip_delete` |
 * | 7 | 클립 게인 변경 | `clip_gain` |
 * | 8 | 페이드 변경 | `clip_fade` |
 * | 9 | 클립 음소거 전환 | `clip_mute` |
 * | 10 | 트랙 음량 변경 | `track_volume` |
 * | 11 | 트랙 팬 변경 | `track_pan` |
 * | 12 | 트랙 솔로 전환 | `track_solo` |
 *
 * **Track mute has no command**, and that is the requirement's shape rather than an omission
 * here: Requirement 28.20 and 28.32 both treat a track's mute state as stored, but neither
 * 28.23 nor design §6.4 lists changing it among the undoable operations. Recorded as an open
 * question in task 4.1's report; a `track_mute` command would be a thirteenth operation and
 * would make the acceptance criterion's "12개 편집 조작" wrong.
 *
 * ### A command is data, and it carries its own inverse
 *
 * Design §6.4 states the interface as `execute(project)` / `undo(project)`, which a class with
 * captured state satisfies. This module instead models each command as a **record holding the
 * before and after values**, with `executeCommand` and `undoCommand` as pure functions over
 * it, and offers `commandHandle` for a caller that wants §6.4's object shape literally.
 *
 * The reason is Requirement 28.37. An `undo` that recomputed the previous state — "move it
 * back by the delta" — is a second implementation of the operation and can disagree with the
 * first; the classic case is a move that was snapped (Requirement 28.21), where the delta the
 * user asked for is not the delta that was applied. Capturing the prior value at plan time
 * makes the inverse exact by construction rather than by argument, and makes it exact for
 * `clip_split` and `clip_delete` too, where "recompute" would have to reconstruct a clip.
 *
 * ### Planning is separate from executing
 *
 * `planX` validates the request against Requirement 28's rules and returns either the command
 * or the violations; `executeCommand` then cannot fail. That split is what lets the history in
 * `history.ts` hold only commands that succeeded — Requirement 28.22 records 편집 조작 1건이
 * 성공한 (a *successful* operation) — and it is what makes Requirement 28.8's rejection
 * payload available at the point of the request rather than after a partial mutation.
 */

import type { EffectChain } from '../effects/chain';

import {
  AUTO_PLACEMENT_GAP_MS,
  CLIP_PLAY_LENGTH_MIN_MS,
  PROJECT_CLIP_COUNT_MAX,
  fadeCeilingMs,
} from './bounds';
import {
  clipEndTimeMs,
  clipIndexOf,
  clipPlayLengthMs,
  clipViolations,
  findClip,
  findOverlaps,
  nextAppendStartTimeMs,
  trackViolations,
  withClips,
  withTrack,
  type ClipOverlap,
  type TimelineClip,
  type TimelineProject,
  type TimelineViolation,
} from './project';
import { resolveSnappedStartTime, type SnapCandidate } from './snapping';

/** Design §6.4's twelve types, in Requirement 28.23's order. */
export const EDIT_COMMAND_TYPES = [
  'clip_add',
  'clip_move',
  'clip_trim',
  'clip_split',
  'clip_duplicate',
  'clip_delete',
  'clip_gain',
  'clip_fade',
  'clip_mute',
  'track_volume',
  'track_pan',
  'track_solo',
] as const;

export type EditCommandType = (typeof EDIT_COMMAND_TYPES)[number];

export interface ClipPlacement {
  readonly startTimeMs: number;
  readonly track: number;
}

export interface ClipTrim {
  readonly trimStartMs: number;
  readonly trimEndMs: number;
}

export interface ClipFades {
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

/**
 * A planned, validated edit.
 *
 * Each variant holds exactly what its inverse needs and nothing more. `index` appears where
 * the clip list's *order* would otherwise be lost — Requirement 28.32 makes order part of the
 * equivalence relation, so an undone delete must go back where it was, not on the end.
 */
export type EditCommand =
  | { readonly type: 'clip_add'; readonly clip: TimelineClip }
  | {
      readonly type: 'clip_move';
      readonly clipId: string;
      readonly before: ClipPlacement;
      readonly after: ClipPlacement;
      /** The snap candidate that decided `after`, when Requirement 28.21 applied. */
      readonly snappedTo: SnapCandidate | null;
    }
  | {
      readonly type: 'clip_trim';
      readonly clipId: string;
      readonly before: ClipTrim;
      readonly after: ClipTrim;
      /** Fades clamped by Requirement 28.17 as a consequence of the new play length. */
      readonly beforeFades: ClipFades;
      readonly afterFades: ClipFades;
    }
  | {
      readonly type: 'clip_split';
      readonly index: number;
      readonly original: TimelineClip;
      readonly left: TimelineClip;
      readonly right: TimelineClip;
    }
  | { readonly type: 'clip_duplicate'; readonly clip: TimelineClip }
  | { readonly type: 'clip_delete'; readonly index: number; readonly clip: TimelineClip }
  | {
      readonly type: 'clip_gain';
      readonly clipId: string;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly type: 'clip_fade';
      readonly clipId: string;
      readonly before: ClipFades;
      readonly after: ClipFades;
    }
  | {
      readonly type: 'clip_mute';
      readonly clipId: string;
      readonly before: boolean;
      readonly after: boolean;
    }
  | {
      readonly type: 'track_volume';
      readonly track: number;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly type: 'track_pan';
      readonly track: number;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly type: 'track_solo';
      readonly track: number;
      readonly before: boolean;
      readonly after: boolean;
    };

/** Why a request was refused. Requirement 28.8's payload rides in `overlaps`. */
export interface EditRejection {
  readonly violations: readonly TimelineViolation[];
  readonly overlaps: readonly ClipOverlap[];
}

export type EditPlan =
  | { readonly ok: true; readonly command: EditCommand }
  | { readonly ok: false } & EditRejection;

function rejected(
  violations: readonly TimelineViolation[],
  overlaps: readonly ClipOverlap[] = [],
): EditPlan {
  return { ok: false, violations, overlaps };
}

function planned(command: EditCommand): EditPlan {
  return { ok: true, command };
}

/* ------------------------------------------------------------------ execution */

/** Apply a planned command. Cannot fail: `planX` already validated the request. */
export function executeCommand(project: TimelineProject, command: EditCommand): TimelineProject {
  switch (command.type) {
    case 'clip_add':
    case 'clip_duplicate':
      return withClips(project, [...project.clips, command.clip]);

    case 'clip_move':
      return patchClip(project, command.clipId, () => command.after);

    case 'clip_trim':
      return patchClip(project, command.clipId, () => ({
        ...command.after,
        ...command.afterFades,
      }));

    case 'clip_split':
      return withClips(project, [
        ...project.clips.slice(0, command.index),
        command.left,
        command.right,
        ...project.clips.slice(command.index + 1),
      ]);

    case 'clip_delete':
      return withClips(project, [
        ...project.clips.slice(0, command.index),
        ...project.clips.slice(command.index + 1),
      ]);

    case 'clip_gain':
      return patchClip(project, command.clipId, () => ({ gainDb: command.after }));

    case 'clip_fade':
      return patchClip(project, command.clipId, () => command.after);

    case 'clip_mute':
      return patchClip(project, command.clipId, () => ({ muted: command.after }));

    case 'track_volume':
      return patchTrack(project, command.track, { volumeDb: command.after });

    case 'track_pan':
      return patchTrack(project, command.track, { pan: command.after });

    case 'track_solo':
      return patchTrack(project, command.track, { solo: command.after });
  }
}

/**
 * Requirement 28.37: put the project back exactly as it was before `command` ran.
 *
 * Every branch restores a *captured* value rather than recomputing one. See the header.
 */
export function undoCommand(project: TimelineProject, command: EditCommand): TimelineProject {
  switch (command.type) {
    case 'clip_add':
    case 'clip_duplicate':
      // Both append, so both are undone by removing that clip wherever it now sits. Removing
      // "the last element" would be wrong the moment a caller reorders the list.
      return withClips(
        project,
        project.clips.filter((clip) => clip.id !== command.clip.id),
      );

    case 'clip_move':
      return patchClip(project, command.clipId, () => command.before);

    case 'clip_trim':
      return patchClip(project, command.clipId, () => ({
        ...command.before,
        ...command.beforeFades,
      }));

    case 'clip_split': {
      // The two halves occupy `index` and `index + 1` after execution, so the original goes
      // back in their place — which restores both the clip *and* the list order 28.32 compares.
      const index = clipIndexOf(project, command.left.id);
      if (index < 0) return project;
      return withClips(project, [
        ...project.clips.slice(0, index),
        command.original,
        ...project.clips.slice(index + 2),
      ]);
    }

    case 'clip_delete':
      return withClips(project, [
        ...project.clips.slice(0, command.index),
        command.clip,
        ...project.clips.slice(command.index),
      ]);

    case 'clip_gain':
      return patchClip(project, command.clipId, () => ({ gainDb: command.before }));

    case 'clip_fade':
      return patchClip(project, command.clipId, () => command.before);

    case 'clip_mute':
      return patchClip(project, command.clipId, () => ({ muted: command.before }));

    case 'track_volume':
      return patchTrack(project, command.track, { volumeDb: command.before });

    case 'track_pan':
      return patchTrack(project, command.track, { pan: command.before });

    case 'track_solo':
      return patchTrack(project, command.track, { solo: command.before });
  }
}

/**
 * Design §6.4's `EditCommand` interface, for a caller that wants the object form.
 *
 * The record is the source of truth; this is a view over it. Keeping the record as the stored
 * form means the history is inspectable data rather than a list of closures, which is what
 * makes `test/unit/timeline/history.test.ts` able to assert *which* twelve operations a
 * hundred-entry history holds.
 */
export interface EditCommandHandle {
  readonly type: EditCommandType;
  execute(project: TimelineProject): TimelineProject;
  undo(project: TimelineProject): TimelineProject;
}

export function commandHandle(command: EditCommand): EditCommandHandle {
  return {
    type: command.type,
    execute: (project) => executeCommand(project, command),
    undo: (project) => undoCommand(project, command),
  };
}

function patchClip(
  project: TimelineProject,
  clipId: string,
  patch: (clip: TimelineClip) => Partial<TimelineClip>,
): TimelineProject {
  return withClips(
    project,
    project.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch(clip) } : clip)),
  );
}

function patchTrack(
  project: TimelineProject,
  track: number,
  patch: Partial<{ volumeDb: number; pan: number; muted: boolean; solo: boolean }>,
): TimelineProject {
  const existing = project.tracks[track];
  if (existing === undefined) return project;
  return withTrack(project, track, { ...existing, ...patch });
}

/* -------------------------------------------------------------------- planning */

function clipMissing(clipId: string): TimelineViolation {
  return { field: 'clipId', violation: 'clip_id_required', actual: clipId };
}

/**
 * The shared tail of every clip-modifying plan: the modified clip must satisfy Requirement 28's
 * per-clip rules *and* must not collide with anything else on its track (28.7, 28.8).
 */
function validateModifiedClip(
  project: TimelineProject,
  candidate: TimelineClip,
): EditRejection | null {
  const violations = clipViolations(candidate);
  if (violations.length > 0) return { violations, overlaps: [] };

  const overlaps = findOverlaps(project, candidate);
  if (overlaps.length > 0) {
    return {
      violations: [
        {
          index: clipIndexOf(project, candidate.id),
          field: 'startTimeMs',
          violation: 'clip_overlap',
          expected: 'no overlap on the destination track',
          actual: `${String(overlaps[0]?.overlapMs ?? 0)} ms`,
        },
      ],
      overlaps,
    };
  }

  return null;
}

export interface AddClipRequest {
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceDurationMs: number;
  readonly track: number;
  /** Requirement 28.6: omitted means "after everything already here". */
  readonly startTimeMs?: number;
  readonly trimStartMs?: number;
  readonly trimEndMs?: number;
  readonly gainDb?: number;
  readonly fadeInMs?: number;
  readonly fadeOutMs?: number;
  readonly muted?: boolean;
  /**
   * Requirement 29.31's chain, if the clip is added with one. Omitted means none.
   *
   * There is **no edit command for changing a clip's chain**, and that is deliberate:
   * Requirement 28.23 enumerates exactly twelve operations and design §6.4's
   * `EditCommandType` mirrors them, so a thirteenth would falsify task 4.1's acceptance
   * criterion. A chain therefore reaches a clip either here or through an imported project
   * document. Recorded as an open question — see the task 4.3 report.
   */
  readonly effectChain?: EffectChain | null;
}

/** Requirements 28.2, 28.5, 28.6, 28.7, 28.8. */
export function planAddClip(project: TimelineProject, request: AddClipRequest): EditPlan {
  // Requirement 28.5: the 501st is refused, and the error carries the current count and the
  // ceiling — both, as data, because a client that wants to say "500 of 500" needs each.
  if (project.clips.length >= PROJECT_CLIP_COUNT_MAX) {
    return rejected([
      {
        field: 'clips',
        violation: 'clip_count_exceeded',
        expected: String(PROJECT_CLIP_COUNT_MAX),
        actual: String(project.clips.length),
      },
    ]);
  }

  if (findClip(project, request.clipId) !== undefined) {
    return rejected([
      { field: 'id', violation: 'clip_id_duplicate', actual: request.clipId },
    ]);
  }

  const clip: TimelineClip = {
    id: request.clipId,
    assetId: request.assetId,
    sourceDurationMs: request.sourceDurationMs,
    startTimeMs: request.startTimeMs ?? nextAppendStartTimeMs(project),
    track: request.track,
    trimStartMs: request.trimStartMs ?? 0,
    trimEndMs: request.trimEndMs ?? 0,
    gainDb: request.gainDb ?? 0,
    fadeInMs: request.fadeInMs ?? 0,
    fadeOutMs: request.fadeOutMs ?? 0,
    muted: request.muted ?? false,
    effectChain: request.effectChain ?? null,
  };

  const rejection = validateModifiedClip(project, clip);
  if (rejection !== null) return rejected(rejection.violations, rejection.overlaps);

  return planned({ type: 'clip_add', clip });
}

export interface MoveClipRequest {
  readonly clipId: string;
  readonly startTimeMs: number;
  /** Omitted keeps the clip on its current track. */
  readonly track?: number;
  /** Requirement 28.21's `WHERE 스냅 기능이 활성화된 경우`. */
  readonly snapEnabled?: boolean;
}

/** Requirements 28.7, 28.8, 28.21. */
export function planMoveClip(project: TimelineProject, request: MoveClipRequest): EditPlan {
  const clip = findClip(project, request.clipId);
  if (clip === undefined) return rejected([clipMissing(request.clipId)]);

  const snap = resolveSnappedStartTime(project, request.startTimeMs, {
    enabled: request.snapEnabled ?? false,
    movingClipId: clip.id,
  });

  const after: ClipPlacement = {
    startTimeMs: snap.startTimeMs,
    track: request.track ?? clip.track,
  };
  const candidate: TimelineClip = { ...clip, ...after };

  const rejection = validateModifiedClip(project, candidate);
  if (rejection !== null) return rejected(rejection.violations, rejection.overlaps);

  return planned({
    type: 'clip_move',
    clipId: clip.id,
    before: { startTimeMs: clip.startTimeMs, track: clip.track },
    after,
    snappedTo: snap.candidate,
  });
}

export interface TrimClipRequest {
  readonly clipId: string;
  readonly trimStartMs: number;
  readonly trimEndMs: number;
}

/**
 * Requirements 28.10, 28.11, 28.12, 28.13, 28.17.
 *
 * Requirement 28.12 — trimming must not alter the source file — is satisfied structurally:
 * a trim writes two integers on the clip and never touches the asset. There is nothing to
 * enforce, which is why nothing here does.
 *
 * Requirement 28.11 asks for 허용 최대 트림 값 in the rejection, so an over-trim reports the
 * largest sum that would have been accepted rather than only that the request was too large.
 */
export function planTrimClip(project: TimelineProject, request: TrimClipRequest): EditPlan {
  const clip = findClip(project, request.clipId);
  if (clip === undefined) return rejected([clipMissing(request.clipId)]);

  if (
    !Number.isInteger(request.trimStartMs) ||
    !Number.isInteger(request.trimEndMs) ||
    request.trimStartMs < 0 ||
    request.trimEndMs < 0
  ) {
    return rejected([
      {
        field: 'trimStartMs',
        violation: 'clip_trim_invalid',
        expected: 'non-negative integer milliseconds for both trims',
        actual: `${String(request.trimStartMs)}, ${String(request.trimEndMs)}`,
      },
    ]);
  }

  const maximumTrimSum = clip.sourceDurationMs - CLIP_PLAY_LENGTH_MIN_MS;
  if (request.trimStartMs + request.trimEndMs > maximumTrimSum) {
    return rejected([
      {
        field: 'trimEndMs',
        violation: 'clip_trim_exceeds_source',
        // Requirement 28.11's 허용 최대 트림 값.
        expected: String(maximumTrimSum),
        actual: String(request.trimStartMs + request.trimEndMs),
      },
    ]);
  }

  const after: ClipTrim = { trimStartMs: request.trimStartMs, trimEndMs: request.trimEndMs };
  const playLength = clip.sourceDurationMs - after.trimStartMs - after.trimEndMs;
  // Requirement 28.17 is relative to play length, so a trim that shortens the clip can leave a
  // previously legal fade illegal. Clamping keeps the invariant true rather than refusing an
  // otherwise valid trim, and the clamp is recorded in the command so the undo restores the
  // fades that were there — not the clamped ones.
  const afterFades: ClipFades = {
    fadeInMs: Math.min(clip.fadeInMs, fadeCeilingMs(playLength)),
    fadeOutMs: Math.min(clip.fadeOutMs, fadeCeilingMs(playLength)),
  };

  const candidate: TimelineClip = { ...clip, ...after, ...afterFades };
  const rejection = validateModifiedClip(project, candidate);
  if (rejection !== null) return rejected(rejection.violations, rejection.overlaps);

  return planned({
    type: 'clip_trim',
    clipId: clip.id,
    before: { trimStartMs: clip.trimStartMs, trimEndMs: clip.trimEndMs },
    after,
    beforeFades: { fadeInMs: clip.fadeInMs, fadeOutMs: clip.fadeOutMs },
    afterFades,
  });
}

export interface SplitClipRequest {
  readonly clipId: string;
  /** Absolute timeline position of the cut. */
  readonly atMs: number;
  readonly leftClipId: string;
  readonly rightClipId: string;
}

/**
 * Requirement 28.14: two clips over the same asset whose play lengths sum to the original's.
 *
 * The arithmetic is stated in terms of trims, which is what makes the sum exact rather than
 * approximately right: the left half keeps `trimStartMs` and gains the tail as extra
 * `trimEndMs`; the right half keeps `trimEndMs` and gains the head as extra `trimStartMs`. So
 * `leftPlay + rightPlay = (offset) + (playLength − offset) = playLength`, identically, with no
 * rounding anywhere.
 *
 * **Fades at the cut become zero**, which Requirement 28 does not specify. Requirement 28.14
 * constrains only the length sum, and 28.17's ceiling is relative to play length, so *some*
 * rule is needed or a split could leave a fade longer than half of its half. The rule chosen
 * is the one a DAW uses and the one that preserves what the user hears at the two outer edges:
 * the left half keeps the original fade in (clamped to its new, shorter ceiling) and fades out
 * at 0; the right half fades in at 0 and keeps the original fade out (likewise clamped).
 * Copying both fades to both halves would invent a fade in the middle of previously continuous
 * audio. Recorded as an open question in task 4.1's report.
 *
 * **Both halves keep the original's `Effect_Chain`**, inherited through the spread. Requirement
 * 29.31 makes a chain a per-clip setting applied to that clip's trimmed audio, and both halves
 * are clips over the same asset; giving the chain to only one of them would silently unprocess
 * half of previously processed audio. It does mean the two halves are processed *independently*,
 * so a delay tail that would have crossed the cut point no longer does — which is a
 * consequence of Requirement 29.31's per-clip processing and not of this rule, and is the same
 * thing that already happens at the outer edge of any clip (see `clip-effects.ts`).
 */
export function planSplitClip(project: TimelineProject, request: SplitClipRequest): EditPlan {
  const clip = findClip(project, request.clipId);
  if (clip === undefined) return rejected([clipMissing(request.clipId)]);

  // A split adds one clip, so the ceiling of Requirement 28.5 applies to it too.
  if (project.clips.length >= PROJECT_CLIP_COUNT_MAX) {
    return rejected([
      {
        field: 'clips',
        violation: 'clip_count_exceeded',
        expected: String(PROJECT_CLIP_COUNT_MAX),
        actual: String(project.clips.length),
      },
    ]);
  }

  const offset = request.atMs - clip.startTimeMs;
  const playLength = clipPlayLengthMs(clip);
  if (
    !Number.isInteger(request.atMs) ||
    offset < CLIP_PLAY_LENGTH_MIN_MS ||
    playLength - offset < CLIP_PLAY_LENGTH_MIN_MS
  ) {
    return rejected([
      {
        field: 'atMs',
        violation: 'clip_play_length_too_short',
        expected:
          `an integer strictly inside ` +
          `${String(clip.startTimeMs + CLIP_PLAY_LENGTH_MIN_MS)}..` +
          `${String(clipEndTimeMs(clip) - CLIP_PLAY_LENGTH_MIN_MS)}`,
        actual: String(request.atMs),
      },
    ]);
  }

  for (const id of [request.leftClipId, request.rightClipId]) {
    if (id !== clip.id && findClip(project, id) !== undefined) {
      return rejected([{ field: 'id', violation: 'clip_id_duplicate', actual: id }]);
    }
  }
  if (request.leftClipId === request.rightClipId) {
    return rejected([
      { field: 'id', violation: 'clip_id_duplicate', actual: request.leftClipId },
    ]);
  }

  const left: TimelineClip = {
    ...clip,
    id: request.leftClipId,
    trimEndMs: clip.trimEndMs + (playLength - offset),
    fadeInMs: Math.min(clip.fadeInMs, fadeCeilingMs(offset)),
    fadeOutMs: 0,
  };
  const right: TimelineClip = {
    ...clip,
    id: request.rightClipId,
    startTimeMs: request.atMs,
    trimStartMs: clip.trimStartMs + offset,
    fadeInMs: 0,
    fadeOutMs: Math.min(clip.fadeOutMs, fadeCeilingMs(playLength - offset)),
  };

  const violations = [...clipViolations(left), ...clipViolations(right)];
  if (violations.length > 0) return rejected(violations);

  // The two halves are contiguous by construction, so only the *rest* of the track can
  // collide — and it cannot, since together they occupy exactly the original's interval. The
  // check runs anyway, because "cannot" here rests on the arithmetic above being right.
  const overlaps = [
    ...findOverlaps(project, left, clip.id),
    ...findOverlaps(project, right, clip.id),
  ];
  if (overlaps.length > 0) {
    return rejected(
      [
        {
          field: 'startTimeMs',
          violation: 'clip_overlap',
          actual: `${String(overlaps[0]?.overlapMs ?? 0)} ms`,
        },
      ],
      overlaps,
    );
  }

  return planned({
    type: 'clip_split',
    index: clipIndexOf(project, clip.id),
    original: clip,
    left,
    right,
  });
}

export interface DuplicateClipRequest {
  readonly clipId: string;
  readonly newClipId: string;
}

/**
 * Requirement 28.15: the copy keeps the trims, the gain and the fades, and lands 200 ms after
 * the original's end.
 *
 * On the *same* track, which 28.15 does not say and which is the only reading that makes the
 * stated placement meaningful — a start time relative to the original's end is a statement
 * about that track's timeline. A copy that collides with something already there is refused
 * under 28.8 rather than nudged along, because nudging would silently ignore the placement
 * 28.15 requires.
 */
export function planDuplicateClip(
  project: TimelineProject,
  request: DuplicateClipRequest,
): EditPlan {
  const clip = findClip(project, request.clipId);
  if (clip === undefined) return rejected([clipMissing(request.clipId)]);

  if (project.clips.length >= PROJECT_CLIP_COUNT_MAX) {
    return rejected([
      {
        field: 'clips',
        violation: 'clip_count_exceeded',
        expected: String(PROJECT_CLIP_COUNT_MAX),
        actual: String(project.clips.length),
      },
    ]);
  }

  if (findClip(project, request.newClipId) !== undefined) {
    return rejected([
      { field: 'id', violation: 'clip_id_duplicate', actual: request.newClipId },
    ]);
  }

  const copy: TimelineClip = {
    ...clip,
    id: request.newClipId,
    startTimeMs: clipEndTimeMs(clip) + AUTO_PLACEMENT_GAP_MS,
  };

  const rejection = validateModifiedClip(project, copy);
  if (rejection !== null) return rejected(rejection.violations, rejection.overlaps);

  return planned({ type: 'clip_duplicate', clip: copy });
}

/** Requirement 28.23's 삭제. */
export function planDeleteClip(project: TimelineProject, clipId: string): EditPlan {
  const index = clipIndexOf(project, clipId);
  const clip = project.clips[index];
  if (index < 0 || clip === undefined) return rejected([clipMissing(clipId)]);
  return planned({ type: 'clip_delete', index, clip });
}

/** Requirement 28.16. */
export function planClipGain(
  project: TimelineProject,
  clipId: string,
  gainDb: number,
): EditPlan {
  const clip = findClip(project, clipId);
  if (clip === undefined) return rejected([clipMissing(clipId)]);

  const violations = clipViolations({ ...clip, gainDb });
  if (violations.length > 0) return rejected(violations);

  return planned({ type: 'clip_gain', clipId, before: clip.gainDb, after: gainDb });
}

/** Requirement 28.17. */
export function planClipFades(
  project: TimelineProject,
  clipId: string,
  fades: ClipFades,
): EditPlan {
  const clip = findClip(project, clipId);
  if (clip === undefined) return rejected([clipMissing(clipId)]);

  const violations = clipViolations({ ...clip, ...fades });
  if (violations.length > 0) return rejected(violations);

  return planned({
    type: 'clip_fade',
    clipId,
    before: { fadeInMs: clip.fadeInMs, fadeOutMs: clip.fadeOutMs },
    after: fades,
  });
}

/**
 * Requirement 28.23's 클립 음소거 전환.
 *
 * A toggle, as the clause says (전환), so the caller does not pass a value. That also makes the
 * inverse unambiguous — the captured `before` is the state that was there, whatever it was.
 */
export function planClipMute(project: TimelineProject, clipId: string): EditPlan {
  const clip = findClip(project, clipId);
  if (clip === undefined) return rejected([clipMissing(clipId)]);
  return planned({ type: 'clip_mute', clipId, before: clip.muted, after: !clip.muted });
}

function trackAt(project: TimelineProject, track: number): TimelineViolation | null {
  if (project.tracks[track] === undefined) {
    return {
      field: 'track',
      violation: 'clip_track_range',
      expected: `0..${String(project.tracks.length - 1)}`,
      actual: String(track),
    };
  }
  return null;
}

/** Requirement 28.18's volume. */
export function planTrackVolume(
  project: TimelineProject,
  track: number,
  volumeDb: number,
): EditPlan {
  const missing = trackAt(project, track);
  if (missing !== null) return rejected([missing]);
  const settings = project.tracks[track];
  if (settings === undefined) return rejected([]);

  const violations = trackViolations({ ...settings, volumeDb }, track);
  if (violations.length > 0) return rejected(violations);

  return planned({ type: 'track_volume', track, before: settings.volumeDb, after: volumeDb });
}

/** Requirement 28.18's pan. */
export function planTrackPan(project: TimelineProject, track: number, pan: number): EditPlan {
  const missing = trackAt(project, track);
  if (missing !== null) return rejected([missing]);
  const settings = project.tracks[track];
  if (settings === undefined) return rejected([]);

  const violations = trackViolations({ ...settings, pan }, track);
  if (violations.length > 0) return rejected(violations);

  return planned({ type: 'track_pan', track, before: settings.pan, after: pan });
}

/** Requirement 28.19's solo, as a toggle — the clause says 전환. */
export function planTrackSolo(project: TimelineProject, track: number): EditPlan {
  const missing = trackAt(project, track);
  if (missing !== null) return rejected([missing]);
  const settings = project.tracks[track];
  if (settings === undefined) return rejected([]);

  return planned({ type: 'track_solo', track, before: settings.solo, after: !settings.solo });
}
