/**
 * Bounds Requirement 28 states as *structure*, kept apart from the perceptual thresholds
 * of Requirement 34.
 *
 * Same split as `domain/sfx/bounds.ts`, `domain/v2a/bounds.ts` and
 * `domain/sound-pack/bounds.ts`, for the same reason those files give: a number that
 * defines what a thing *is* belongs here, and a number that expresses a judgement about
 * which audio is *admissible* belongs in the Quality_Threshold_Set so an operator can
 * retune it under Requirement 34.4 without a deploy.
 *
 * Every number in Requirement 28 falls on this side of that line, including the two that
 * look like candidates for the threshold set:
 *
 * **The 50 ms snap window of Requirement 28.21 is a bound, not a threshold.** Three
 * reasons, and the third is the decisive one:
 *
 * 1. Requirement 34.1's stated subject is 청감 관련 임계값 — perceptual judgements about
 *    generated audio. A snap window is an *interaction affordance*: it decides where a
 *    dragged clip lands, and it is a claim about pointer precision rather than about how
 *    anything sounds. Earlier tasks already flagged that `sound_pack_export_budget_ms`
 *    strains that subject (see `domain/quality/threshold-name.ts`); a UI window strains it
 *    much further, since it is not even a ceiling on a measured quantity.
 * 2. Requirement 34.6 records the threshold-set version *on every asset admitted against
 *    it*, and Requirement 34.10 forbids reinterpreting an already-recorded measurement.
 *    Nothing is measured here and nothing is recorded, so a snap window in the set would
 *    be a member whose version stamp is meaningless.
 * 3. Requirement 28.21 states the window as part of the *definition* of the move
 *    operation — the clause is unintelligible without it, in the way 24.9's 0.95 ceiling
 *    is perfectly intelligible as "some ceiling". Moving it would change what a move
 *    request *means*, which is exactly the test `domain/sfx/bounds.ts` uses to keep
 *    measurement windows out of the set.
 *
 * The practical consequence of the alternative is worth recording too: adding a member to
 * `QUALITY_THRESHOLD_NAMES` obliges an edit to the exhaustive list asserted by
 * `test/unit/bgm/threshold-set.test.ts`, and every asset would then carry a version stamp
 * that moves when a UI affordance is retuned.
 *
 * **The 200 ms auto-placement gap of Requirements 28.6 and 28.15 is likewise a bound.**
 * It is a layout convention, not a judgement about audio.
 *
 * ### Two bounds Requirement 28 does not state
 *
 * Requirement 28.1 requires a project to have a name and a description and gives neither a
 * length. `PROJECT_NAME_*` and `PROJECT_DESCRIPTION_*` below are therefore **derived**, not
 * quoted: the name range matches `ASSET_NAME_MIN_LENGTH`/`ASSET_NAME_MAX_LENGTH` in
 * `domain/audio-asset.ts` so the two things a user names in this product are named the same
 * way, and the description allows the empty string because 28.1 does not make it mandatory
 * content. **Open question for the spec** — see the report accompanying task 4.1.
 */

/** Requirement 28.4: the permitted `track` values, inclusive. */
export const TRACK_INDEX_MIN = 0;
export const TRACK_INDEX_MAX = 31;

/**
 * The number of tracks a project has.
 *
 * Stated as a count as well as a range because a project stores one `TrackSettings` per
 * track (Requirement 28.32 compares "각 트랙의" volume, pan, mute and solo), and a
 * positional array needs the count rather than the endpoints.
 */
export const TRACK_COUNT = TRACK_INDEX_MAX - TRACK_INDEX_MIN + 1;

/** Requirement 28.5: at most 500 clips per project; the 501st is refused. */
export const PROJECT_CLIP_COUNT_MAX = 500;

/**
 * Requirements 28.6 and 28.15: the gap left when a start time is not given.
 *
 * One constant for both clauses because they are the same convention seen twice — an
 * appended clip and a duplicated clip both land 200 ms after the end of what is already
 * there.
 */
export const AUTO_PLACEMENT_GAP_MS = 200;

/** Requirement 28.16: clip gain, in decibels, inclusive. */
export const CLIP_GAIN_DB_MIN = -40;
export const CLIP_GAIN_DB_MAX = 12;

/**
 * Requirement 28.17: a fade is at least 0 ms and at most half the clip's play length.
 *
 * A ratio rather than a duration, because the ceiling is relative to the clip.
 */
export const FADE_MAX_PLAY_LENGTH_RATIO = 0.5;

/** Requirement 28.18: track volume in decibels and track pan, both inclusive. */
export const TRACK_VOLUME_DB_MIN = -60;
export const TRACK_VOLUME_DB_MAX = 12;
export const TRACK_PAN_MIN = -1.0;
export const TRACK_PAN_MAX = 1.0;

/** Requirement 28.18's defaults: unity gain, centred, audible. */
export const TRACK_VOLUME_DB_DEFAULT = 0;
export const TRACK_PAN_DEFAULT = 0;

/** Requirement 28.21: the window inside which a snap candidate is considered. */
export const SNAP_WINDOW_MS = 50;

/** Requirement 28.22: undo history depth. The 101st entry evicts the oldest. */
export const UNDO_HISTORY_MAX = 100;

/** Requirement 28.39: tempo, in integer BPM, inclusive. */
export const TEMPO_BPM_MIN = 30;
export const TEMPO_BPM_MAX = 300;

/** Requirement 28.39: the four permitted beats-per-bar values. */
export const TIME_SIGNATURES = [2, 3, 4, 6] as const;
export type TimeSignature = (typeof TIME_SIGNATURES)[number];

/** Requirement 28.35: every track's playhead must agree within this budget. */
export const PLAYHEAD_TOLERANCE_MS = 20;

/**
 * Requirement 28.32's comparison tolerances, which *define* the project equivalence
 * relation of design §7.1 and so belong with the other structural numbers.
 *
 * Times and identifiers are exact; gain and track volume agree within 0.1 dB; pan within
 * 0.01.
 */
export const PROJECT_GAIN_TOLERANCE_DB = 0.1;
export const PROJECT_PAN_TOLERANCE = 0.01;

/** Derived, not quoted — see the header. Matches `domain/audio-asset.ts`. */
export const PROJECT_NAME_MIN_LENGTH = 1;
export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_DESCRIPTION_MIN_LENGTH = 0;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Requirement 28.13: a clip's play length is at least one millisecond.
 *
 * Requirement 28.10 states the trim invariant as a strict inequality — the trims sum to
 * *less than* the source length — which already forbids a zero-length clip. This constant
 * names the consequence so a split or a trim can be refused with a number rather than with
 * an off-by-one argument.
 */
export const CLIP_PLAY_LENGTH_MIN_MS = 1;

export function isTrackIndex(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TRACK_INDEX_MIN &&
    value <= TRACK_INDEX_MAX
  );
}

export function isTempoBpm(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TEMPO_BPM_MIN &&
    value <= TEMPO_BPM_MAX
  );
}

export function isTimeSignature(value: unknown): value is TimeSignature {
  return (
    typeof value === 'number' && (TIME_SIGNATURES as readonly number[]).includes(value)
  );
}

/** Requirement 28.3: every time value is an integer count of milliseconds. */
export function isTimeMs(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isClipGainDb(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= CLIP_GAIN_DB_MIN &&
    value <= CLIP_GAIN_DB_MAX
  );
}

export function isTrackVolumeDb(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= TRACK_VOLUME_DB_MIN &&
    value <= TRACK_VOLUME_DB_MAX
  );
}

export function isTrackPan(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= TRACK_PAN_MIN &&
    value <= TRACK_PAN_MAX
  );
}

/**
 * Requirement 28.17's ceiling for a clip of the given play length.
 *
 * Floored, because Requirement 28.3 makes every time value an integer: for an odd play
 * length the exact half is not representable, and rounding *up* would admit a fade longer
 * than half the clip.
 */
export function fadeCeilingMs(playLengthMs: number): number {
  return Math.floor(playLengthMs * FADE_MAX_PLAY_LENGTH_RATIO);
}

export function isFadeMs(value: unknown, playLengthMs: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= fadeCeilingMs(playLengthMs)
  );
}

/**
 * Requirement 28.39: the length of one bar, in milliseconds.
 *
 * `null` when either value is unset, which is what makes Requirement 28.21's "마디 경계
 * 후보를 0개로 취급" a single check at the call site rather than a condition repeated in
 * every caller. Not rounded here — the caller rounds each boundary, so that bar *n* is at
 * `round(n · barLength)` rather than at `n · round(barLength)`, which would accumulate up
 * to half a millisecond of drift per bar.
 */
export function barLengthMs(
  tempoBpm: number | null,
  timeSignature: number | null,
): number | null {
  if (tempoBpm === null || timeSignature === null) return null;
  if (!isTempoBpm(tempoBpm) || !isTimeSignature(timeSignature)) return null;
  return (60_000 / tempoBpm) * timeSignature;
}
