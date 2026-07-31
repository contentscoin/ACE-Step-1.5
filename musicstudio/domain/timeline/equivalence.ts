/**
 * The **project equivalence relation** (Requirement 28.32, design §7.1).
 *
 * Requirement 28.32 defines it precisely, and it is the relation four separate obligations
 * are stated against — the round trip (28.32), the idempotence (28.33), the undo/redo round
 * trip (28.23) and the undo inverse (28.37). So it is written once, here, and those four
 * never disagree about what "동등" means.
 *
 * What 28.32 says, itemised:
 *
 * - **compared**: project name, description, clip list *order*, and per clip the clip id,
 *   asset id, `start_time_ms`, `track`, `trim_start_ms`, `trim_end_ms`, gain, fade in, fade
 *   out and mute flag; and per track the volume, pan, mute state and solo state;
 * - **exactly**: 시각 값과 식별자 — times and identifiers;
 * - **within 0.1 dB**: clip gain and track volume;
 * - **within 0.01**: pan;
 * - **excluded**: undo history, and created/updated times.
 *
 * The exclusions need no code: `TimelineProject` holds none of those three (see
 * `project.ts`), which is why it does not. That is the point of keeping them out of the
 * type — an exclusion enforced by the shape cannot be forgotten by a comparison.
 *
 * ### Numeric comparison is by absolute difference, never `toBe` or `Object.is`
 *
 * The same lesson `domain/sound-pack/equivalence.ts` and `domain/effects/equivalence.ts`
 * record, and the reason applies here for real rather than hypothetically: **`JSON.stringify(-0)`
 * is `"0"`**. A pan of `-0` is the identical pan to `0` and a gain of `-0` the identical
 * gain, but they are values a client can send and a generator can produce, and they do not
 * survive a round trip as themselves. `Object.is(-0, 0)` is `false`, so an identity
 * comparison would fail Property 6 for two numbers denoting the same quantity.
 *
 * `!(drift <= tolerance)` rather than `drift > tolerance`, so a `NaN` difference — which
 * compares `false` against everything — is *reported* rather than accepted.
 *
 * Every mismatch returns a reason. A property failure that says only `false` costs a
 * debugging session; one that says `clip 3 startTimeMs 1200 !== 1201` does not.
 */

import { PROJECT_GAIN_TOLERANCE_DB, PROJECT_PAN_TOLERANCE } from './bounds';
import {
  TIMELINE_CLIP_FIELDS,
  TRACK_SETTINGS_FIELDS,
  type TimelineClip,
  type TimelineProject,
  type TrackSettings,
} from './project';

export type ProjectEquivalenceVerdict =
  | { readonly equivalent: true }
  | { readonly equivalent: false; readonly reason: string };

const EQUIVALENT: ProjectEquivalenceVerdict = { equivalent: true };

function differs(reason: string): ProjectEquivalenceVerdict {
  return { equivalent: false, reason };
}

/**
 * Requirement 28.32's tolerance per clip field.
 *
 * `0` for the time values and the identifiers, which 28.32 requires to match exactly.
 * The zero entries are still routed through the absolute-difference comparison rather than
 * `===` so that `-0` and `0` compare equal there too — a `startTimeMs` of `-0` is not
 * reachable through validation (28.3 requires a non-negative integer, and `-0` satisfies it)
 * but the printer would still emit `0`, and a relation that failed on it would be wrong.
 */
const CLIP_NUMERIC_TOLERANCES = {
  sourceDurationMs: 0,
  startTimeMs: 0,
  track: 0,
  trimStartMs: 0,
  trimEndMs: 0,
  gainDb: PROJECT_GAIN_TOLERANCE_DB,
  fadeInMs: 0,
  fadeOutMs: 0,
} as const;

type ClipNumericField = keyof typeof CLIP_NUMERIC_TOLERANCES;

const TRACK_NUMERIC_TOLERANCES = {
  volumeDb: PROJECT_GAIN_TOLERANCE_DB,
  pan: PROJECT_PAN_TOLERANCE,
} as const;

type TrackNumericField = keyof typeof TRACK_NUMERIC_TOLERANCES;

function withinTolerance(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

export function timelineClipsEquivalent(
  left: TimelineClip,
  right: TimelineClip,
  index: number,
): ProjectEquivalenceVerdict {
  const where = `clip ${String(index)} (${left.id})`;

  // Iterated over the field list rather than written out, so a twelfth clip field is a type
  // error here rather than a field the relation quietly stops looking at.
  for (const field of TIMELINE_CLIP_FIELDS) {
    if (field in CLIP_NUMERIC_TOLERANCES) {
      const tolerance = CLIP_NUMERIC_TOLERANCES[field as ClipNumericField];
      const leftValue = left[field as ClipNumericField];
      const rightValue = right[field as ClipNumericField];
      if (!withinTolerance(leftValue, rightValue, tolerance)) {
        return differs(
          `${where} ${field} drifted ${String(Math.abs(leftValue - rightValue))} ` +
            `(> ${String(tolerance)}): ${String(leftValue)} vs ${String(rightValue)}`,
        );
      }
      continue;
    }

    const leftValue = left[field];
    const rightValue = right[field];
    if (leftValue !== rightValue) {
      return differs(`${where} ${field} ${String(leftValue)} !== ${String(rightValue)}`);
    }
  }

  return EQUIVALENT;
}

export function trackSettingsEquivalent(
  left: TrackSettings,
  right: TrackSettings,
  track: number,
): ProjectEquivalenceVerdict {
  for (const field of TRACK_SETTINGS_FIELDS) {
    if (field in TRACK_NUMERIC_TOLERANCES) {
      const tolerance = TRACK_NUMERIC_TOLERANCES[field as TrackNumericField];
      const leftValue = left[field as TrackNumericField];
      const rightValue = right[field as TrackNumericField];
      if (!withinTolerance(leftValue, rightValue, tolerance)) {
        return differs(
          `track ${String(track)} ${field} drifted ` +
            `${String(Math.abs(leftValue - rightValue))} (> ${String(tolerance)}): ` +
            `${String(leftValue)} vs ${String(rightValue)}`,
        );
      }
      continue;
    }

    if (left[field] !== right[field]) {
      return differs(
        `track ${String(track)} ${field} ${String(left[field])} !== ${String(right[field])}`,
      );
    }
  }

  return EQUIVALENT;
}

/** Requirement 28.32's relation, in full. */
export function timelineProjectsEquivalent(
  left: TimelineProject,
  right: TimelineProject,
): ProjectEquivalenceVerdict {
  // The project id is compared as an identifier: 28.32 requires 식별자 to match exactly, and
  // two projects with different ids are two projects however alike their contents.
  if (left.id !== right.id) return differs(`project id ${left.id} !== ${right.id}`);
  if (left.ownerId !== right.ownerId) {
    return differs(`ownerId ${left.ownerId} !== ${right.ownerId}`);
  }
  if (left.name !== right.name) return differs(`name ${left.name} !== ${right.name}`);
  if (left.description !== right.description) {
    return differs(`description ${left.description} !== ${right.description}`);
  }

  // Requirement 28.39's stored values. Not named by 28.32's enumeration, and compared anyway:
  // a round trip that lost the tempo would change which bar boundaries 28.21 offers, so a
  // relation that ignored it would let Property 6 pass for a printer that dropped it.
  if (left.tempoBpm !== right.tempoBpm) {
    return differs(`tempoBpm ${String(left.tempoBpm)} !== ${String(right.tempoBpm)}`);
  }
  if (left.timeSignature !== right.timeSignature) {
    return differs(
      `timeSignature ${String(left.timeSignature)} !== ${String(right.timeSignature)}`,
    );
  }

  if (left.clips.length !== right.clips.length) {
    return differs(`clip count ${String(left.clips.length)} !== ${String(right.clips.length)}`);
  }

  // Index by index, not as a set keyed by clip id: 28.32 names 클립 목록의 순서 explicitly, and
  // comparing as a set would let Property 6 pass for a printer that lost the ordering.
  for (const [index, leftClip] of left.clips.entries()) {
    const rightClip = right.clips[index];
    if (rightClip === undefined) return differs(`clip ${String(index)} missing`);
    const verdict = timelineClipsEquivalent(leftClip, rightClip, index);
    if (!verdict.equivalent) return verdict;
  }

  if (left.tracks.length !== right.tracks.length) {
    return differs(
      `track count ${String(left.tracks.length)} !== ${String(right.tracks.length)}`,
    );
  }

  for (const [track, leftTrack] of left.tracks.entries()) {
    const rightTrack = right.tracks[track];
    if (rightTrack === undefined) return differs(`track ${String(track)} missing`);
    const verdict = trackSettingsEquivalent(leftTrack, rightTrack, track);
    if (!verdict.equivalent) return verdict;
  }

  return EQUIVALENT;
}

/** Convenience for the call sites that only need the boolean. */
export function projectsEquivalent(left: TimelineProject, right: TimelineProject): boolean {
  return timelineProjectsEquivalent(left, right).equivalent;
}

/** The reason, or the empty string, for use as a `vitest` assertion message. */
export function equivalenceReason(verdict: ProjectEquivalenceVerdict): string {
  return verdict.equivalent ? '' : verdict.reason;
}
