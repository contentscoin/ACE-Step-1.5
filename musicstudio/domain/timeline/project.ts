/**
 * `Timeline_Project` and `Timeline_Clip` — the stored state and its invariants
 * (Requirements 28.1–28.18, design §4.1, §6.4).
 *
 * ### The project holds no history and no timestamps
 *
 * Design §6.4 gives the command interface as `execute(project) => project`, and Requirement
 * 28.32 excludes 되돌리기 이력 and 생성·수정 시각 from the project equivalence relation. Both
 * point the same way: the thing an edit transforms, the thing the printer serialises and the
 * thing the equivalence relation compares are one type, and the mutable bookkeeping around
 * it is another. So `TimelineProject` is the *state*, `EditHistory` (see `history.ts`) is
 * separate, and `TimelineProjectRecord` (see `services/timeline/`) is what a store keeps.
 *
 * The alternative — one struct with a `history` field that the printer skips and the
 * relation ignores — makes both of those exclusions a rule someone has to remember, and
 * makes the byte-identity of Requirement 28.33 depend on remembering it.
 *
 * ### A clip carries its source duration
 *
 * Requirements 28.10, 28.11 and 28.13 are all stated in terms of 원본 자산 길이, and 28.13
 * makes play length a *derived* quantity: `source - trimStart - trimEnd`. Storing the source
 * duration on the clip keeps every one of those rules a pure function of the project, so
 * overlap (28.7), snapping (28.21) and undo (28.23) need no asset lookup and are testable
 * without one. The cost is a denormalised copy, and the parser guards it: given a catalogue
 * it rejects a document whose stored duration disagrees with the asset's (see
 * `project-parser.ts`), which is the drift the copy could otherwise hide.
 *
 * ### Tracks are a positional array of exactly 32
 *
 * Requirement 28.4 fixes the range at 0–31 and Requirement 28.32 compares "각 트랙의" four
 * settings, so every track has settings whether or not anyone has touched it. A dense
 * 32-element array indexed by track number makes that total and makes Requirement 28.33's
 * byte-identity free: there is no key order to inherit and no sparse-versus-default
 * ambiguity for the printer to resolve. A map keyed by track number would reintroduce both.
 */

import {
  AUTO_PLACEMENT_GAP_MS,
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  CLIP_PLAY_LENGTH_MIN_MS,
  PROJECT_CLIP_COUNT_MAX,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_DESCRIPTION_MIN_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  TRACK_COUNT,
  TRACK_INDEX_MAX,
  TRACK_INDEX_MIN,
  TRACK_PAN_DEFAULT,
  TRACK_PAN_MAX,
  TRACK_PAN_MIN,
  TRACK_VOLUME_DB_DEFAULT,
  TRACK_VOLUME_DB_MAX,
  TRACK_VOLUME_DB_MIN,
  TEMPO_BPM_MAX,
  TEMPO_BPM_MIN,
  TIME_SIGNATURES,
  fadeCeilingMs,
  isClipGainDb,
  isFadeMs,
  isTempoBpm,
  isTimeMs,
  isTimeSignature,
  isTrackIndex,
  isTrackPan,
  isTrackVolumeDb,
} from './bounds';
import { chainViolations } from '../effects/chain';
import type { EffectChain } from '../effects/chain';

/** Requirement 28.2's stored fields, plus the identifier 28.32 compares. */
export interface TimelineClip {
  readonly id: string;
  readonly assetId: string;
  /** The referenced `Audio_Asset`'s length. See the header on why it lives here. */
  readonly sourceDurationMs: number;
  readonly startTimeMs: number;
  readonly track: number;
  readonly trimStartMs: number;
  readonly trimEndMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly muted: boolean;
  /**
   * Requirement 29.31's per-clip Effect_Chain. `null` when the clip has none.
   *
   * Deliberately **not** in `TIMELINE_CLIP_FIELDS`. That list is the field set Requirement
   * 28.32 enumerates for the project equivalence relation, and 28.32 does not name a chain;
   * more importantly the relation compares its members with `!==`, which two structurally
   * identical chains from a round trip would fail. The chain is compared instead by design
   * §7.1's *chain equivalence relation* — see `timelineClipsEquivalent`.
   */
  readonly effectChain: EffectChain | null;
}

/**
 * The clip fields, in the order the printer writes them and the relation compares them.
 *
 * One list rather than three, for the reason `CUE_MANIFEST_ENTRY_FIELDS` exists: a field
 * added to `TimelineClip` and not to this list is a type error at the printer and at the
 * equivalence relation, rather than a field they both silently stop looking at.
 */
export const TIMELINE_CLIP_FIELDS = [
  'id',
  'assetId',
  'sourceDurationMs',
  'startTimeMs',
  'track',
  'trimStartMs',
  'trimEndMs',
  'gainDb',
  'fadeInMs',
  'fadeOutMs',
  'muted',
] as const satisfies readonly (keyof TimelineClip)[];

/** Requirement 28.18's per-track settings, plus 28.19/28.20's solo and mute states. */
export interface TrackSettings {
  readonly volumeDb: number;
  readonly pan: number;
  readonly muted: boolean;
  readonly solo: boolean;
}

export const TRACK_SETTINGS_FIELDS = [
  'volumeDb',
  'pan',
  'muted',
  'solo',
] as const satisfies readonly (keyof TrackSettings)[];

/**
 * The editable state of a `Timeline_Project`.
 *
 * `tempoBpm` and `timeSignature` are independently nullable because Requirement 28.39
 * legislates for a project where they are unset, and Requirement 28.21 keys bar-boundary
 * snapping off the tempo alone. Making them a single optional pair would rule out the state
 * 28.39 explicitly describes.
 */
export interface TimelineProject {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly tempoBpm: number | null;
  readonly timeSignature: number | null;
  readonly clips: readonly TimelineClip[];
  /** Exactly `TRACK_COUNT` entries, indexed by track number. */
  readonly tracks: readonly TrackSettings[];
}

export type TimelineViolationCode =
  | 'project_id_required'
  | 'project_owner_required'
  | 'project_name_length'
  | 'project_description_length'
  | 'project_tempo_range'
  | 'project_time_signature_unknown'
  | 'project_track_count'
  | 'clip_count_exceeded'
  | 'clip_id_required'
  | 'clip_id_duplicate'
  | 'clip_asset_id_required'
  | 'clip_source_duration_invalid'
  | 'clip_start_time_invalid'
  | 'clip_track_range'
  | 'clip_trim_invalid'
  | 'clip_trim_exceeds_source'
  | 'clip_play_length_too_short'
  | 'clip_gain_range'
  | 'clip_fade_range'
  | 'clip_mute_invalid'
  | 'clip_effect_chain_invalid'
  | 'clip_overlap'
  | 'track_volume_range'
  | 'track_pan_range'
  | 'track_flag_invalid';

/**
 * One violated rule.
 *
 * Structurally a superset of design §7.2's `ParseError` minus `violation`'s free-form
 * spelling, so `project-parser.ts` maps a violation to a `ParseError` field for field
 * instead of restating the rules. `index` is the clip index or the track number, whichever
 * the rule is about; `field` says which.
 */
export interface TimelineViolation {
  readonly index?: number;
  readonly field?: string;
  readonly violation: TimelineViolationCode;
  readonly expected?: string;
  readonly actual?: string;
}

/** Requirement 28.8's payload: which two clips collide, and by how much. */
export interface ClipOverlap {
  readonly clipId: string;
  readonly otherClipId: string;
  readonly track: number;
  readonly overlapMs: number;
}

/** Requirement 28.13: play length is derived, never stored. */
export function clipPlayLengthMs(clip: TimelineClip): number {
  return clip.sourceDurationMs - clip.trimStartMs - clip.trimEndMs;
}

/** The exclusive end of the clip's playback interval. */
export function clipEndTimeMs(clip: TimelineClip): number {
  return clip.startTimeMs + clipPlayLengthMs(clip);
}

/** Requirement 28.18's defaults, for a track nobody has touched. */
export function defaultTrackSettings(): TrackSettings {
  return {
    volumeDb: TRACK_VOLUME_DB_DEFAULT,
    pan: TRACK_PAN_DEFAULT,
    muted: false,
    solo: false,
  };
}

export function defaultTracks(): TrackSettings[] {
  return Array.from({ length: TRACK_COUNT }, () => defaultTrackSettings());
}

/** Requirement 28.1: a new project, with an empty clip list. */
export function createTimelineProject(seed: {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description?: string;
  readonly tempoBpm?: number | null;
  readonly timeSignature?: number | null;
}): TimelineProject {
  return {
    id: seed.id,
    ownerId: seed.ownerId,
    name: seed.name,
    description: seed.description ?? '',
    tempoBpm: seed.tempoBpm ?? null,
    timeSignature: seed.timeSignature ?? null,
    clips: [],
    tracks: defaultTracks(),
  };
}

/**
 * How much two clips overlap, in milliseconds; `0` when they merely touch.
 *
 * The interval is half-open — `[start, start + playLength)` — so a clip that begins exactly
 * where another ends does not collide. Requirement 28.7 forbids 재생 구간이 겹치는 상태, and
 * two intervals sharing only an endpoint are never simultaneously audible.
 */
export function overlapMs(left: TimelineClip, right: TimelineClip): number {
  const start = Math.max(left.startTimeMs, right.startTimeMs);
  const end = Math.min(clipEndTimeMs(left), clipEndTimeMs(right));
  return Math.max(0, end - start);
}

/**
 * Requirement 28.8: every clip in `project` that the candidate would collide with.
 *
 * `ignoreClipId` exists for the move and trim operations, which compare a modified clip
 * against the rest of the project and must not find the clip's own former placement.
 */
export function findOverlaps(
  project: TimelineProject,
  candidate: TimelineClip,
  ignoreClipId: string = candidate.id,
): ClipOverlap[] {
  const collisions: ClipOverlap[] = [];

  for (const other of project.clips) {
    if (other.id === ignoreClipId) continue;
    if (other.track !== candidate.track) continue;
    const overlap = overlapMs(candidate, other);
    if (overlap <= 0) continue;
    collisions.push({
      clipId: candidate.id,
      otherClipId: other.id,
      track: candidate.track,
      overlapMs: overlap,
    });
  }

  return collisions;
}

/**
 * Requirement 28.6: the start time for a clip added without one.
 *
 * Computed over *all* clips rather than over the target track's clips, because 28.6 says
 * "기존 클립들의 최대 종료 시각" without qualification. That is also the behaviour a user
 * expects from "append": the new material starts after everything already in the project.
 */
export function nextAppendStartTimeMs(project: TimelineProject): number {
  if (project.clips.length === 0) return 0;
  const latestEnd = project.clips.reduce(
    (latest, clip) => Math.max(latest, clipEndTimeMs(clip)),
    0,
  );
  return latestEnd + AUTO_PLACEMENT_GAP_MS;
}

function range(min: number, max: number): string {
  return `${String(min)}..${String(max)}`;
}

/**
 * Requirements 28.2, 28.3, 28.4, 28.10, 28.11, 28.13, 28.16, 28.17 for one clip.
 *
 * Every violated rule is returned rather than the first, following
 * `domain/sound-pack/manifest.ts`: a clip can be wrong in several fields at once and a
 * caller told about one at a time makes several round trips to learn what it could have
 * sent. `index` is filled in by the project-level check, which knows the clip's position.
 */
export function clipViolations(clip: TimelineClip): TimelineViolation[] {
  const violations: TimelineViolation[] = [];

  if (typeof clip.id !== 'string' || clip.id.length === 0) {
    violations.push({ field: 'id', violation: 'clip_id_required' });
  }
  if (typeof clip.assetId !== 'string' || clip.assetId.length === 0) {
    violations.push({ field: 'assetId', violation: 'clip_asset_id_required' });
  }

  const sourceValid =
    typeof clip.sourceDurationMs === 'number' &&
    Number.isInteger(clip.sourceDurationMs) &&
    clip.sourceDurationMs >= CLIP_PLAY_LENGTH_MIN_MS;
  if (!sourceValid) {
    violations.push({
      field: 'sourceDurationMs',
      violation: 'clip_source_duration_invalid',
      expected: `an integer >= ${String(CLIP_PLAY_LENGTH_MIN_MS)}`,
      actual: String(clip.sourceDurationMs),
    });
  }

  if (!isTimeMs(clip.startTimeMs)) {
    violations.push({
      field: 'startTimeMs',
      violation: 'clip_start_time_invalid',
      expected: 'a non-negative integer number of milliseconds',
      actual: String(clip.startTimeMs),
    });
  }

  if (!isTrackIndex(clip.track)) {
    violations.push({
      field: 'track',
      violation: 'clip_track_range',
      expected: range(TRACK_INDEX_MIN, TRACK_INDEX_MAX),
      actual: String(clip.track),
    });
  }

  // Requirement 28.10's first half: both trims are non-negative integers.
  const trimsWellFormed = isTimeMs(clip.trimStartMs) && isTimeMs(clip.trimEndMs);
  if (!trimsWellFormed) {
    violations.push({
      field: 'trimStartMs',
      violation: 'clip_trim_invalid',
      expected: 'non-negative integer milliseconds for both trims',
      actual: `${String(clip.trimStartMs)}, ${String(clip.trimEndMs)}`,
    });
  }

  if (trimsWellFormed && sourceValid) {
    // Requirement 28.10's second half, stated as a strict inequality by the clause and so
    // enforced as one: trims that consume the whole asset leave nothing to play.
    if (clip.trimStartMs + clip.trimEndMs >= clip.sourceDurationMs) {
      violations.push({
        field: 'trimEndMs',
        violation: 'clip_trim_exceeds_source',
        expected: `trimStartMs + trimEndMs < ${String(clip.sourceDurationMs)}`,
        actual: String(clip.trimStartMs + clip.trimEndMs),
      });
    } else if (clipPlayLengthMs(clip) < CLIP_PLAY_LENGTH_MIN_MS) {
      violations.push({
        field: 'trimEndMs',
        violation: 'clip_play_length_too_short',
        expected: `>= ${String(CLIP_PLAY_LENGTH_MIN_MS)} ms of play length`,
        actual: String(clipPlayLengthMs(clip)),
      });
    }
  }

  // Requirement 29.31: a chain on a clip is the same chain Requirement 29.9 validates, so it
  // is checked with the same function rather than a second, drifting copy of the rules.
  if (clip.effectChain !== null && clip.effectChain !== undefined) {
    for (const violation of chainViolations(clip.effectChain)) {
      const expected = violation.permittedRange ?? violation.name;
      violations.push({
        field: 'effectChain',
        index: violation.index,
        violation: 'clip_effect_chain_invalid',
        ...(expected === undefined ? {} : { expected }),
        actual: violation.violation,
      });
    }
  }

  if (!isClipGainDb(clip.gainDb)) {
    violations.push({
      field: 'gainDb',
      violation: 'clip_gain_range',
      expected: range(CLIP_GAIN_DB_MIN, CLIP_GAIN_DB_MAX),
      actual: String(clip.gainDb),
    });
  }

  // Requirement 28.17 is relative to play length, so it can only be checked once the trims
  // and the source duration are known to be coherent.
  if (trimsWellFormed && sourceValid && clipPlayLengthMs(clip) >= CLIP_PLAY_LENGTH_MIN_MS) {
    const ceiling = fadeCeilingMs(clipPlayLengthMs(clip));
    for (const field of ['fadeInMs', 'fadeOutMs'] as const) {
      if (!isFadeMs(clip[field], clipPlayLengthMs(clip))) {
        violations.push({
          field,
          violation: 'clip_fade_range',
          expected: range(0, ceiling),
          actual: String(clip[field]),
        });
      }
    }
  }

  if (typeof clip.muted !== 'boolean') {
    violations.push({
      field: 'muted',
      violation: 'clip_mute_invalid',
      expected: 'true or false',
      actual: String(clip.muted),
    });
  }

  return violations;
}

/** Requirement 28.18 for one track's settings. */
export function trackViolations(track: TrackSettings, index: number): TimelineViolation[] {
  const violations: TimelineViolation[] = [];

  if (!isTrackVolumeDb(track.volumeDb)) {
    violations.push({
      index,
      field: 'volumeDb',
      violation: 'track_volume_range',
      expected: range(TRACK_VOLUME_DB_MIN, TRACK_VOLUME_DB_MAX),
      actual: String(track.volumeDb),
    });
  }
  if (!isTrackPan(track.pan)) {
    violations.push({
      index,
      field: 'pan',
      violation: 'track_pan_range',
      expected: range(TRACK_PAN_MIN, TRACK_PAN_MAX),
      actual: String(track.pan),
    });
  }

  // Requirements 28.19 and 28.20 turn on these two flags, so a document that supplied
  // something else for either would silently change which clips a mixdown renders.
  for (const field of ['muted', 'solo'] as const) {
    if (typeof track[field] !== 'boolean') {
      violations.push({
        index,
        field,
        violation: 'track_flag_invalid',
        expected: 'true or false',
        actual: String(track[field]),
      });
    }
  }

  return violations;
}

/**
 * Every rule Requirement 28 states about a stored project, including the two invariants
 * (28.5's ceiling and 28.7's non-overlap) that are properties of the *set* of clips.
 *
 * This is the function that decides whether a project is *valid*, and therefore the
 * function the round-trip properties of design §10 quantify over. Nothing here consults an
 * asset catalogue: existence of the referenced assets is Requirement 28.34's rule and lives
 * in the parser, because a project already in memory may legitimately reference an asset
 * that has since been marked deleted (Requirement 28.36) without becoming invalid.
 */
export function projectViolations(project: TimelineProject): TimelineViolation[] {
  const violations: TimelineViolation[] = [];

  if (typeof project.id !== 'string' || project.id.length === 0) {
    violations.push({ field: 'id', violation: 'project_id_required' });
  }
  if (typeof project.ownerId !== 'string' || project.ownerId.length === 0) {
    violations.push({ field: 'ownerId', violation: 'project_owner_required' });
  }

  if (
    typeof project.name !== 'string' ||
    project.name.length < PROJECT_NAME_MIN_LENGTH ||
    project.name.length > PROJECT_NAME_MAX_LENGTH
  ) {
    violations.push({
      field: 'name',
      violation: 'project_name_length',
      expected: range(PROJECT_NAME_MIN_LENGTH, PROJECT_NAME_MAX_LENGTH),
      actual: String(typeof project.name === 'string' ? project.name.length : project.name),
    });
  }

  if (
    typeof project.description !== 'string' ||
    project.description.length < PROJECT_DESCRIPTION_MIN_LENGTH ||
    project.description.length > PROJECT_DESCRIPTION_MAX_LENGTH
  ) {
    violations.push({
      field: 'description',
      violation: 'project_description_length',
      expected: range(PROJECT_DESCRIPTION_MIN_LENGTH, PROJECT_DESCRIPTION_MAX_LENGTH),
      actual: String(
        typeof project.description === 'string' ? project.description.length : project.description,
      ),
    });
  }

  if (project.tempoBpm !== null && !isTempoBpm(project.tempoBpm)) {
    violations.push({
      field: 'tempoBpm',
      violation: 'project_tempo_range',
      expected: `${range(TEMPO_BPM_MIN, TEMPO_BPM_MAX)} integer BPM, or null`,
      actual: String(project.tempoBpm),
    });
  }

  if (project.timeSignature !== null && !isTimeSignature(project.timeSignature)) {
    violations.push({
      field: 'timeSignature',
      violation: 'project_time_signature_unknown',
      expected: TIME_SIGNATURES.join(', '),
      actual: String(project.timeSignature),
    });
  }

  if (!Array.isArray(project.tracks) || project.tracks.length !== TRACK_COUNT) {
    violations.push({
      field: 'tracks',
      violation: 'project_track_count',
      expected: String(TRACK_COUNT),
      actual: String(Array.isArray(project.tracks) ? project.tracks.length : project.tracks),
    });
  } else {
    for (const [index, track] of project.tracks.entries()) {
      violations.push(...trackViolations(track, index));
    }
  }

  // Requirement 28.5: the ceiling is a property of the stored project, not only of the add
  // operation, so a document holding 501 clips is rejected by the parser too.
  if (project.clips.length > PROJECT_CLIP_COUNT_MAX) {
    violations.push({
      field: 'clips',
      violation: 'clip_count_exceeded',
      expected: String(PROJECT_CLIP_COUNT_MAX),
      actual: String(project.clips.length),
    });
  }

  const seenIds = new Set<string>();
  for (const [index, clip] of project.clips.entries()) {
    for (const violation of clipViolations(clip)) {
      violations.push({ ...violation, index });
    }
    if (seenIds.has(clip.id)) {
      violations.push({
        index,
        field: 'id',
        violation: 'clip_id_duplicate',
        actual: clip.id,
      });
    }
    seenIds.add(clip.id);
  }

  // Requirement 28.7's invariant, over every pair on the same track. Quadratic in the clip
  // count, which at the 500-clip ceiling is 124 750 comparisons — cheap enough to run on
  // every validation, and the alternative (a per-track sort) would need the clips to be
  // well-formed first, which is exactly what is in question here.
  for (const [index, clip] of project.clips.entries()) {
    for (const other of project.clips.slice(index + 1)) {
      if (other.track !== clip.track) continue;
      const overlap = overlapMs(clip, other);
      if (overlap <= 0) continue;
      violations.push({
        index,
        field: 'startTimeMs',
        violation: 'clip_overlap',
        expected: `no overlap with clip ${other.id} on track ${String(clip.track)}`,
        actual: `${String(overlap)} ms`,
      });
    }
  }

  return violations;
}

export function isValidTimelineProject(project: TimelineProject): boolean {
  return projectViolations(project).length === 0;
}

/** Position of a clip in the project's list, or `-1`. Order is part of 28.32's relation. */
export function clipIndexOf(project: TimelineProject, clipId: string): number {
  return project.clips.findIndex((clip) => clip.id === clipId);
}

export function findClip(project: TimelineProject, clipId: string): TimelineClip | undefined {
  return project.clips.find((clip) => clip.id === clipId);
}

/** Replace the clip list, leaving everything else alone. */
export function withClips(
  project: TimelineProject,
  clips: readonly TimelineClip[],
): TimelineProject {
  return { ...project, clips };
}

/** Replace one track's settings, leaving everything else alone. */
export function withTrack(
  project: TimelineProject,
  track: number,
  settings: TrackSettings,
): TimelineProject {
  return {
    ...project,
    tracks: project.tracks.map((existing, index) => (index === track ? settings : existing)),
  };
}
