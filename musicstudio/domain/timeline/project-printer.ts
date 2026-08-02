/**
 * `Project_Printer` (Requirement 28.30; design §7.1).
 *
 * Turns a `Timeline_Project` into the JSON project document. Requirement 28.33 demands the
 * *bytes* of a reprint be identical, which is the strongest of the five idempotence rows in
 * design §7.1 and which rests entirely on two decisions — the same two
 * `domain/sound-pack/manifest-printer.ts` and `domain/effects/chain-printer.ts` make, so the
 * same two rather than new ones:
 *
 * **1. Key order is fixed, not inherited.** `JSON.stringify` preserves an object's insertion
 * order, so a project assembled by a client with `track` before `startTimeMs` would print
 * differently from the identical project after a parse — and Requirement 28.33's byte
 * comparison would fail for two structures the equivalence relation calls equal. Every object
 * here is therefore written out field by field, in `TIMELINE_CLIP_FIELDS` and
 * `TRACK_SETTINGS_FIELDS` order, never spread from the source.
 *
 * **2. Numbers are printed by `JSON.stringify`, unmodified.** No rounding, no fixed decimal
 * count. `JSON.stringify` emits the shortest representation that round-trips a double
 * exactly, so tidying here would *introduce* the drift Requirement 28.32's tolerances then
 * have to absorb.
 *
 * The one wrinkle, which is not hypothetical: **`JSON.stringify(-0)` is `"0"`**. A clip gain
 * or a track pan of `-0` therefore comes back as `+0`. It is the same quantity, so the
 * printer does not special-case it — emitting `-0` would produce a document no other JSON
 * implementation reads back — and `equivalence.ts` compares numbers by absolute difference so
 * that the pair still counts as equal. Byte-identity is unaffected, because the second print
 * starts from the parsed `+0` and emits `"0"` again.
 *
 * Clip order is the project's own and is **not** re-sorted. Requirement 28.32 names 클립
 * 목록의 순서 as part of the equivalence relation, so sorting here would hide a reordering
 * instead of letting the round trip reveal it.
 *
 * `tracks` is a positional array of exactly 32 with no `track` field inside each entry. The
 * index *is* the track number; carrying it as data too would be a second copy that a
 * hand-built document could contradict, and there would be no correct answer to which one
 * wins. See `project.ts`.
 */

import {
  TIMELINE_CLIP_FIELDS,
  TRACK_SETTINGS_FIELDS,
  type TimelineClip,
  type TimelineProject,
  type TrackSettings,
} from './project';

/** The wire shape of one clip. Field order here is the printed order. */
export interface TimelineClipDocument {
  readonly id: string;
  readonly assetId: string;
  readonly sourceDurationMs: number;
  readonly startTimeMs: number;
  readonly track: number;
  readonly trimStartMs: number;
  readonly trimEndMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly muted: boolean;
}

export interface TrackSettingsDocument {
  readonly volumeDb: number;
  readonly pan: number;
  readonly muted: boolean;
  readonly solo: boolean;
}

export interface TimelineProjectDocument {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly tempoBpm: number | null;
  readonly timeSignature: number | null;
  readonly clips: readonly TimelineClipDocument[];
  readonly tracks: readonly TrackSettingsDocument[];
}

/**
 * The order the top-level keys are written in.
 *
 * Exported so `test/unit/timeline/serialisation.test.ts` can assert the printed order against
 * a declaration rather than against a hand-copied string that would have to be re-copied
 * every time a field is added.
 */
export const PROJECT_DOCUMENT_FIELDS = [
  'id',
  'ownerId',
  'name',
  'description',
  'tempoBpm',
  'timeSignature',
  'clips',
  'tracks',
] as const satisfies readonly (keyof TimelineProjectDocument)[];

function clipToDocument(clip: TimelineClip): TimelineClipDocument {
  // Written out in `TIMELINE_CLIP_FIELDS` order rather than spread, so the output does not
  // depend on how the clip object happened to be built.
  return {
    id: clip.id,
    assetId: clip.assetId,
    sourceDurationMs: clip.sourceDurationMs,
    startTimeMs: clip.startTimeMs,
    track: clip.track,
    trimStartMs: clip.trimStartMs,
    trimEndMs: clip.trimEndMs,
    gainDb: clip.gainDb,
    fadeInMs: clip.fadeInMs,
    fadeOutMs: clip.fadeOutMs,
    muted: clip.muted,
  };
}

function trackToDocument(track: TrackSettings): TrackSettingsDocument {
  return {
    volumeDb: track.volumeDb,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
  };
}

/**
 * The project as a plain JSON value.
 *
 * Returned as a value rather than a string for the caller about to nest it in a larger
 * payload or hand it to a `jsonb` write, who would otherwise parse the string back — the same
 * reason `manifestToDocument` exists.
 */
export function projectToDocument(project: TimelineProject): TimelineProjectDocument {
  return {
    id: project.id,
    ownerId: project.ownerId,
    name: project.name,
    description: project.description,
    tempoBpm: project.tempoBpm,
    timeSignature: project.timeSignature,
    clips: project.clips.map(clipToDocument),
    tracks: project.tracks.map(trackToDocument),
  };
}

/** Requirement 28.30: the project as the JSON project document. */
export function printProject(project: TimelineProject): string {
  return JSON.stringify(projectToDocument(project));
}

/**
 * The same document, indented.
 *
 * A separate function rather than a flag on `printProject`, for the reason
 * `printManifestPretty` is separate: Requirement 28.33's byte-identity is asserted against
 * `printProject`, and a formatting option threaded through call sites is a way for a stored
 * document to acquire whitespace the comparison does not expect.
 */
export function printProjectPretty(project: TimelineProject): string {
  return JSON.stringify(projectToDocument(project), null, 2);
}

/** The declared field order, for the parity test. Keeps two lists from drifting silently. */
export const CLIP_DOCUMENT_FIELDS = TIMELINE_CLIP_FIELDS;
export const TRACK_DOCUMENT_FIELDS = TRACK_SETTINGS_FIELDS;
