/**
 * Requirement 28.35: seeking, and the 20 ms budget between tracks.
 *
 * > WHEN 사용자가 재생 위치를 이동하면, THE Timeline_Service SHALL **모든 트랙의 재생 위치를**
 * > 요청된 시각과 20밀리초 이내의 오차로 동일하게 유지한다
 *
 * The clause is a tolerance, which invites an implementation with per-track positions that are
 * kept close to each other. That would be the wrong shape: a timeline has *one* playhead, and
 * the 32 tracks of Requirement 28.4 are a layout of one continuous timebase rather than 32
 * independent transports. So `seek` produces a single position and every track reports it, which
 * makes the error identically zero and 28.35 an invariant of the representation rather than
 * something a scheduler has to achieve.
 *
 * The 20 ms budget is not thereby discarded — it is where it belongs, as the tolerance a *client*
 * is allowed against the position this returns. A web player driving 32 lanes off one
 * `AudioContext` clock will drift by a fraction of a buffer, and `withinPlayheadTolerance` is how
 * a test or a client checks that drift against the requirement. Nothing in the product layer can
 * measure a browser's audio clock, so nothing here pretends to.
 *
 * `seek` clamps rather than rejecting. Requirement 28.35 says nothing about a request past the
 * end of the material, and a timeline is unbounded to the right — there is no end to be past. It
 * clamps at zero because Requirement 28.3 makes every time value non-negative.
 */

import { PLAYHEAD_TOLERANCE_MS, TRACK_COUNT } from './bounds';

export interface PlayheadPosition {
  readonly positionMs: number;
  /** Per-track positions, indexed by track. All equal to `positionMs`; see the header. */
  readonly trackPositionsMs: readonly number[];
}

/** Requirement 28.35. */
export function seek(requestedMs: number): PlayheadPosition {
  const positionMs = Math.max(0, Math.round(requestedMs));
  return {
    positionMs,
    trackPositionsMs: Array.from({ length: TRACK_COUNT }, () => positionMs),
  };
}

/** The largest deviation between any track's position and the requested time. */
export function playheadDeviationMs(
  position: PlayheadPosition,
  requestedMs: number,
): number {
  return position.trackPositionsMs.reduce(
    (worst, trackPosition) => Math.max(worst, Math.abs(trackPosition - requestedMs)),
    0,
  );
}

/** Requirement 28.35's budget, for a client or a test to check a measured position against. */
export function withinPlayheadTolerance(
  position: PlayheadPosition,
  requestedMs: number,
  toleranceMs: number = PLAYHEAD_TOLERANCE_MS,
): boolean {
  return playheadDeviationMs(position, requestedMs) <= toleranceMs;
}
