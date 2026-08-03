/**
 * Loop playback (Requirement 12.9).
 *
 * "재생 종료 지점에서 시작 지점으로 이어지는 반복 재생" — a position past the end wraps to
 * the beginning rather than stopping. The arithmetic is trivial and it is here anyway,
 * because the two places that need it (a player asking "where am I on pass three" and a
 * test asserting the wrap is seamless) would otherwise each write their own modulo and
 * disagree about the boundary.
 *
 * Whether an asset loops at all is `Audio_Asset.isLoop`, which task 1.1 stores and
 * Requirement 21 sets; this module is only what to do when it is true.
 */

export interface LoopPosition {
  /** Where in the asset, in [0, durationMs). */
  readonly positionMs: number;
  /** How many times the loop has completed before reaching it. */
  readonly pass: number;
}

/**
 * Where an elapsed time lands inside a looping asset.
 *
 * The end is *exclusive*: at exactly `durationMs` the playhead is at the start of pass one,
 * not at the end of pass zero. That is what makes the seam continuous — the last frame of a
 * pass and the first frame of the next are adjacent, with no position belonging to both.
 */
export function loopPositionAt(elapsedMs: number, durationMs: number): LoopPosition {
  if (durationMs <= 0) return { positionMs: 0, pass: 0 };
  if (elapsedMs <= 0) return { positionMs: 0, pass: 0 };

  const pass = Math.floor(elapsedMs / durationMs);
  return { positionMs: elapsedMs - pass * durationMs, pass };
}

/**
 * Where a non-looping asset lands: the same, but it stops at the end.
 *
 * Stated alongside the looping case rather than left implicit, so a caller chooses between
 * two named behaviours instead of remembering to clamp.
 */
export function linearPositionAt(elapsedMs: number, durationMs: number): LoopPosition {
  if (durationMs <= 0) return { positionMs: 0, pass: 0 };
  return { positionMs: Math.max(0, Math.min(elapsedMs, durationMs)), pass: 0 };
}

export function positionAt(
  elapsedMs: number,
  durationMs: number,
  isLoop: boolean,
): LoopPosition {
  return isLoop ? loopPositionAt(elapsedMs, durationMs) : linearPositionAt(elapsedMs, durationMs);
}
