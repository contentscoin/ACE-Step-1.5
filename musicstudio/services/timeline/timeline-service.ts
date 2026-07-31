/**
 * `Timeline_Service` — project CRUD, the twelve edit operations, and undo/redo
 * (Requirements 28.1–28.23, 28.30–28.39; design §6.4, §7.1).
 *
 * The rules all live in `domain/timeline/`; this service is the part that cannot be pure —
 * ownership, storage, asset existence, and the ordering of "validate, then record, then save".
 * Three things it does, and one it deliberately does not:
 *
 * **1. Every edit goes through the same three steps.** Plan (which validates against Requirement
 * 28 and captures the inverse), execute, record. `applyPlan` is that sequence written once, so
 * the twelve operations of Requirement 28.23 cannot each get it subtly differently — in
 * particular they cannot record a command whose execution failed, which Requirement 28.22's
 * "성공한" forbids.
 *
 * **2. The undo history lives with the project, not with a session.** Requirement 28.22 says
 * 프로젝트당 최근 100회, per project, so it is stored on the record. A session-scoped history
 * would make an undo depend on who is asking, which the clause does not say and which would make
 * "the last 100 operations on this project" unanswerable.
 *
 * **3. Requirement 28.36's flag is computed at read time, not stored.** An asset is marked deleted
 * by whatever deletes it, and a project that references it is not notified. Storing a mirrored
 * flag on the clip would be a second copy that goes stale the moment the asset is restored; asking
 * the catalogue when the project is read cannot. The cost is one lookup per distinct asset per
 * read, which is why `readProject` de-duplicates the ids before asking.
 *
 * **What it does not do: mixdown.** Requirements 28.24–28.29 are the `Mixdown_Renderer`'s and are
 * task 4.2's. `renderTargetSet` (Requirements 28.19, 28.20) is exposed here because the selection
 * is made from state this service owns, but nothing here renders audio.
 */

import { randomUUID } from 'node:crypto';

import { PROJECT_CLIP_COUNT_MAX } from '../../domain/timeline/bounds';
import {
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
  type AddClipRequest,
  type ClipFades,
  type DuplicateClipRequest,
  type EditCommand,
  type EditPlan,
  type MoveClipRequest,
  type SplitClipRequest,
  type TrimClipRequest,
} from '../../domain/timeline/commands';
import {
  createHistory,
  record as recordCommand,
  redo as redoHistory,
  undo as undoHistory,
} from '../../domain/timeline/history';
import { seek, type PlayheadPosition } from '../../domain/timeline/playhead';
import { parseProjectDocument } from '../../domain/timeline/project-parser';
import { printProject, printProjectPretty } from '../../domain/timeline/project-printer';
import {
  createTimelineProject,
  projectViolations,
  type TimelineProject,
} from '../../domain/timeline/project';
import { renderTargetSet, type RenderTargetSet } from '../../domain/timeline/render-target';
import { systemClock, type Clock } from '../clock';

import {
  fromEditRejection,
  timelineAssetNotFound,
  timelineClipLimitReached,
  timelineHistoryEmpty,
  timelineProjectDocumentInvalid,
  timelineProjectForbidden,
  timelineProjectInvalid,
  timelineProjectNotFound,
} from './errors';
import type {
  TimelineAssetCatalogue,
  TimelineProjectRecord,
  TimelineProjectStore,
} from './ports';

export interface TimelineServiceOptions {
  readonly store: TimelineProjectStore;
  readonly assets: TimelineAssetCatalogue;
  readonly clock?: Clock;
  /** Injectable so tests get stable clip and project ids. */
  readonly generateId?: () => string;
}

export interface CreateProjectRequest {
  readonly ownerId: string;
  readonly name: string;
  readonly description?: string;
  readonly tempoBpm?: number | null;
  readonly timeSignature?: number | null;
}

export interface UpdateProjectRequest {
  readonly name?: string;
  readonly description?: string;
  readonly tempoBpm?: number | null;
  readonly timeSignature?: number | null;
}

/** Requirement 28.36: the project, plus the clips whose assets are no longer referenceable. */
export interface ProjectReadResult {
  readonly record: TimelineProjectRecord;
  readonly unreferenceableClipIds: readonly string[];
}

export interface EditResult {
  readonly record: TimelineProjectRecord;
  readonly command: EditCommand;
}

/** What a caller supplies to add a clip; the asset's duration is looked up, not trusted. */
export interface AddClipCommandRequest {
  readonly assetId: string;
  readonly track: number;
  readonly clipId?: string;
  readonly startTimeMs?: number;
  readonly trimStartMs?: number;
  readonly trimEndMs?: number;
  readonly gainDb?: number;
  readonly fadeInMs?: number;
  readonly fadeOutMs?: number;
  readonly muted?: boolean;
}

export function createTimelineService(options: TimelineServiceOptions) {
  const { store, assets } = options;
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? randomUUID;

  function nowMs(): number {
    return clock.now().getTime();
  }

  /** Requirement 28.1's ownership check, which every other method funnels through. */
  async function loadOwned(ownerId: string, projectId: string): Promise<TimelineProjectRecord> {
    const record = await store.load(projectId);
    if (record === null) throw timelineProjectNotFound(projectId);
    if (record.project.ownerId !== ownerId) throw timelineProjectForbidden(projectId);
    return record;
  }

  /**
   * Plan, execute, record, save — the sequence every one of the twelve operations uses.
   *
   * Written once rather than twelve times, which is what makes Requirement 28.22's "only
   * successful operations are recorded" and Requirement 28.8's rejection payload uniform across
   * them. A rejected plan throws before anything is written, so the stored project is untouched —
   * which is also Requirement 28.38's requirement for a refused undo.
   */
  async function applyPlan(
    record: TimelineProjectRecord,
    plan: EditPlan,
  ): Promise<EditResult> {
    if (!plan.ok) throw fromEditRejection(plan);

    const project = executeCommand(record.project, plan.command);
    const next: TimelineProjectRecord = {
      project,
      history: recordCommand(record.history, plan.command),
      createdAtMs: record.createdAtMs,
      updatedAtMs: nowMs(),
    };
    await store.update(next);
    return { record: next, command: plan.command };
  }

  return {
    /** Requirement 28.1: a project with a name, a description and an empty clip list. */
    async createProject(request: CreateProjectRequest): Promise<TimelineProjectRecord> {
      const project = createTimelineProject({
        id: generateId(),
        ownerId: request.ownerId,
        name: request.name,
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.tempoBpm === undefined ? {} : { tempoBpm: request.tempoBpm }),
        ...(request.timeSignature === undefined
          ? {}
          : { timeSignature: request.timeSignature }),
      });

      const violations = projectViolations(project);
      if (violations.length > 0) throw timelineProjectInvalid(violations);

      const now = nowMs();
      const record: TimelineProjectRecord = {
        project,
        history: createHistory(),
        createdAtMs: now,
        updatedAtMs: now,
      };
      await store.insert(record);
      return record;
    },

    /** Requirement 28.36: read, with the unreferenceable clip identifiers alongside. */
    async readProject(ownerId: string, projectId: string): Promise<ProjectReadResult> {
      const record = await loadOwned(ownerId, projectId);

      // De-duplicated, because a project may reference one asset from many clips and the
      // catalogue should be asked once per asset rather than once per clip.
      const assetIds = [...new Set(record.project.clips.map((clip) => clip.assetId))];
      const states = await Promise.all(assetIds.map((assetId) => assets.lookup(assetId)));
      const unavailable = new Set(
        assetIds.filter((assetId, index) => {
          const state = states[index];
          return state === undefined || state === null || state.isDeleted;
        }),
      );

      return {
        record,
        unreferenceableClipIds: record.project.clips
          .filter((clip) => unavailable.has(clip.assetId))
          .map((clip) => clip.id),
      };
    },

    /**
     * Requirements 28.1 and 28.39: rename, redescribe, retempo.
     *
     * Not an undoable operation. Requirement 28.23's list of twelve is clip-level and track-level
     * only, so a rename does not enter the history and does not clear the redo stack — which is
     * the reading that keeps the acceptance criterion's "12개 편집 조작" true. Recorded as an open
     * question in task 4.1's report.
     */
    async updateProject(
      ownerId: string,
      projectId: string,
      patch: UpdateProjectRequest,
    ): Promise<TimelineProjectRecord> {
      const record = await loadOwned(ownerId, projectId);

      const project: TimelineProject = {
        ...record.project,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.tempoBpm === undefined ? {} : { tempoBpm: patch.tempoBpm }),
        ...(patch.timeSignature === undefined ? {} : { timeSignature: patch.timeSignature }),
      };

      const violations = projectViolations(project);
      if (violations.length > 0) throw timelineProjectInvalid(violations);

      const next: TimelineProjectRecord = { ...record, project, updatedAtMs: nowMs() };
      await store.update(next);
      return next;
    },

    async deleteProject(ownerId: string, projectId: string): Promise<void> {
      await loadOwned(ownerId, projectId);
      await store.remove(projectId);
    },

    async listProjects(ownerId: string): Promise<readonly TimelineProjectRecord[]> {
      return store.listByOwner(ownerId);
    },

    /* ------------------------------------------- the twelve operations of 28.23 */

    /** 1. 클립 추가 (Requirements 28.2, 28.5, 28.6, 28.7, 28.8). */
    async addClip(
      ownerId: string,
      projectId: string,
      request: AddClipCommandRequest,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);

      // The ceiling is checked here as well as in `planAddClip`, so that a project already at 500
      // is refused before an asset lookup is spent on it (Requirement 28.5).
      if (record.project.clips.length >= PROJECT_CLIP_COUNT_MAX) {
        throw timelineClipLimitReached(record.project.clips.length);
      }

      const asset = await assets.lookup(request.assetId);
      if (asset === null || asset.isDeleted) throw timelineAssetNotFound(request.assetId);

      // The duration comes from the catalogue, never from the caller: Requirements 28.10, 28.11
      // and 28.13 are all stated against 원본 자산 길이, and a client-supplied length would let a
      // caller trim past the end of the audio by lying about it.
      const clipRequest: AddClipRequest = {
        clipId: request.clipId ?? generateId(),
        assetId: request.assetId,
        sourceDurationMs: asset.durationMs,
        track: request.track,
        ...(request.startTimeMs === undefined ? {} : { startTimeMs: request.startTimeMs }),
        ...(request.trimStartMs === undefined ? {} : { trimStartMs: request.trimStartMs }),
        ...(request.trimEndMs === undefined ? {} : { trimEndMs: request.trimEndMs }),
        ...(request.gainDb === undefined ? {} : { gainDb: request.gainDb }),
        ...(request.fadeInMs === undefined ? {} : { fadeInMs: request.fadeInMs }),
        ...(request.fadeOutMs === undefined ? {} : { fadeOutMs: request.fadeOutMs }),
        ...(request.muted === undefined ? {} : { muted: request.muted }),
      };

      return applyPlan(record, planAddClip(record.project, clipRequest));
    },

    /** 2. 클립 이동 (Requirements 28.7, 28.8, 28.21). */
    async moveClip(
      ownerId: string,
      projectId: string,
      request: MoveClipRequest,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planMoveClip(record.project, request));
    },

    /** 3. 트리밍 (Requirements 28.10–28.13, 28.17). */
    async trimClip(
      ownerId: string,
      projectId: string,
      request: TrimClipRequest,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planTrimClip(record.project, request));
    },

    /** 4. 분할 (Requirement 28.14). */
    async splitClip(
      ownerId: string,
      projectId: string,
      request: { readonly clipId: string; readonly atMs: number },
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      const split: SplitClipRequest = {
        clipId: request.clipId,
        atMs: request.atMs,
        leftClipId: generateId(),
        rightClipId: generateId(),
      };
      return applyPlan(record, planSplitClip(record.project, split));
    },

    /** 5. 복제 (Requirement 28.15). */
    async duplicateClip(
      ownerId: string,
      projectId: string,
      clipId: string,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      const request: DuplicateClipRequest = { clipId, newClipId: generateId() };
      return applyPlan(record, planDuplicateClip(record.project, request));
    },

    /** 6. 삭제. */
    async deleteClip(ownerId: string, projectId: string, clipId: string): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planDeleteClip(record.project, clipId));
    },

    /** 7. 클립 게인 변경 (Requirement 28.16). */
    async setClipGain(
      ownerId: string,
      projectId: string,
      clipId: string,
      gainDb: number,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planClipGain(record.project, clipId, gainDb));
    },

    /** 8. 페이드 변경 (Requirement 28.17). */
    async setClipFades(
      ownerId: string,
      projectId: string,
      clipId: string,
      fades: ClipFades,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planClipFades(record.project, clipId, fades));
    },

    /** 9. 클립 음소거 전환 (Requirement 28.20). */
    async toggleClipMute(
      ownerId: string,
      projectId: string,
      clipId: string,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planClipMute(record.project, clipId));
    },

    /** 10. 트랙 음량 변경 (Requirement 28.18). */
    async setTrackVolume(
      ownerId: string,
      projectId: string,
      track: number,
      volumeDb: number,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planTrackVolume(record.project, track, volumeDb));
    },

    /** 11. 트랙 팬 변경 (Requirement 28.18). */
    async setTrackPan(
      ownerId: string,
      projectId: string,
      track: number,
      pan: number,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planTrackPan(record.project, track, pan));
    },

    /** 12. 트랙 솔로 전환 (Requirement 28.19). */
    async toggleTrackSolo(
      ownerId: string,
      projectId: string,
      track: number,
    ): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      return applyPlan(record, planTrackSolo(record.project, track));
    },

    /* --------------------------------------------------------- undo and redo */

    /** Requirements 28.37, 28.38. */
    async undo(ownerId: string, projectId: string): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      const step = undoHistory(record.project, record.history);
      // Requirement 28.38: the state is not changed, so nothing is written before the throw.
      if (!step.ok) throw timelineHistoryEmpty(step.reason);

      const next: TimelineProjectRecord = {
        project: step.project,
        history: step.history,
        createdAtMs: record.createdAtMs,
        updatedAtMs: nowMs(),
      };
      await store.update(next);
      return { record: next, command: step.command };
    },

    /** Requirements 28.23, 28.38. */
    async redo(ownerId: string, projectId: string): Promise<EditResult> {
      const record = await loadOwned(ownerId, projectId);
      const step = redoHistory(record.project, record.history);
      if (!step.ok) throw timelineHistoryEmpty(step.reason);

      const next: TimelineProjectRecord = {
        project: step.project,
        history: step.history,
        createdAtMs: record.createdAtMs,
        updatedAtMs: nowMs(),
      };
      await store.update(next);
      return { record: next, command: step.command };
    },

    /* ------------------------------------------------- serialisation and reads */

    /** Requirement 28.30. */
    async exportProject(
      ownerId: string,
      projectId: string,
      options: { readonly pretty?: boolean } = {},
    ): Promise<string> {
      const record = await loadOwned(ownerId, projectId);
      return options.pretty === true
        ? printProjectPretty(record.project)
        : printProject(record.project);
    },

    /**
     * Requirements 28.31 and 28.34: read a document back, with the assets checked.
     *
     * The catalogue is built from the document's own asset ids rather than from the account's
     * whole library, so the lookup cost is proportional to the document. An id the catalogue
     * cannot resolve becomes 28.34's error, carrying the clip's index and the missing id.
     */
    async importProject(ownerId: string, document: string): Promise<TimelineProjectRecord> {
      // Parsed once without a catalogue to learn which assets it mentions, then again with one.
      // Two passes rather than a parser that calls back into the service: an async parser could
      // not be a pure function, and Properties 6 and 7 are stated over a pure one.
      const shallow = parseProjectDocument(document);
      if (!shallow.ok) throw timelineProjectDocumentInvalid(shallow.errors);

      const assetIds = [...new Set(shallow.value.clips.map((clip) => clip.assetId))];
      const states = await Promise.all(assetIds.map((assetId) => assets.lookup(assetId)));
      const knownAssets = new Map<string, number>();
      for (const state of states) {
        if (state === null || state.isDeleted) continue;
        knownAssets.set(state.assetId, state.durationMs);
      }

      const parsed = parseProjectDocument(document, { knownAssets });
      if (!parsed.ok) throw timelineProjectDocumentInvalid(parsed.errors);

      const project: TimelineProject = { ...parsed.value, id: generateId(), ownerId };
      const now = nowMs();
      const record: TimelineProjectRecord = {
        project,
        history: createHistory(),
        createdAtMs: now,
        updatedAtMs: now,
      };
      await store.insert(record);
      return record;
    },

    /** Requirements 28.19, 28.20 — the selection task 4.2's renderer consumes. */
    async renderTargets(ownerId: string, projectId: string): Promise<RenderTargetSet> {
      const record = await loadOwned(ownerId, projectId);
      return renderTargetSet(record.project);
    },

    /** Requirement 28.35. */
    seekPlayhead(requestedMs: number): PlayheadPosition {
      return seek(requestedMs);
    },
  };
}

export type TimelineService = ReturnType<typeof createTimelineService>;
