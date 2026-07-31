/**
 * The twelve track names extract and lego accept (Requirements 7.6, 7.7).
 *
 * Transcribed verbatim, in order, from `TRACK_NAMES` in `acestep/constants.py`. The
 * engine is reached only over HTTP (design §1.4.4), so the list is mirrored here
 * rather than imported, and `test/unit/edit/track-name.test.ts` pins the count at
 * the twelve Requirement 7.6 quotes so a silent drift fails there rather than at
 * the engine.
 *
 * The engine also accepts *no* track name for both tasks — `task_utils.py` falls
 * back to `extract_default` / `lego_default` instructions. Requirements 7.6 and 7.7
 * both say a track name is passed, so the product layer requires one and never
 * relies on that fallback; a request without a track is a rejection, not a default.
 */

export const TRACK_NAMES = [
  'woodwinds',
  'brass',
  'fx',
  'synth',
  'strings',
  'percussion',
  'keyboard',
  'guitar',
  'bass',
  'drums',
  'backing_vocals',
  'vocals',
] as const;

export type TrackName = (typeof TRACK_NAMES)[number];

/** Requirement 7.6: the engine supports exactly this many track kinds. */
export const TRACK_NAME_COUNT = 12;

export function isTrackName(value: unknown): value is TrackName {
  return typeof value === 'string' && (TRACK_NAMES as readonly string[]).includes(value);
}
