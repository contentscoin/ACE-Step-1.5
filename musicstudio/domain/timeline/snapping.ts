/**
 * Requirement 28.21's snap rule, and Requirement 28.39's condition on it.
 *
 * The clause is long and every part of it is load-bearing, so it is restated here as the
 * five decisions the code makes:
 *
 * 1. **Candidates** are the start time and the end time of each *other* clip, plus the bar
 *    boundaries derived from the project's tempo and time signature.
 * 2. **The window** is 50 ms, inclusive — "50밀리초 이내에 있는".
 * 3. **The winner** is the candidate at the smallest distance from the requested time.
 * 4. **Ties go to the earlier time** — "거리가 같은 후보가 2개 이상이면 시각이 더 작은 후보".
 * 5. **No candidate** means the requested time is used unchanged, and a project without a
 *    tempo contributes no bar boundaries at all (28.21's last clause, restated by 28.39).
 *
 * ### Which clips are "인접"
 *
 * All other clips in the project, on every track — not only the clips on the destination
 * track. 28.21 says 인접 클립 without qualifying it by track, and a timeline editor that
 * snapped only within a track would refuse to line a sound effect up against the music it is
 * meant to hit, which is the main thing this feature is for. The clip being moved is
 * excluded, since snapping a clip to its own current edges would make every move a no-op.
 *
 * ### Bar boundaries are enumerated, not searched
 *
 * Only two bar boundaries can lie within 50 ms of a given time — the one at or before it and
 * the one after — so the code computes those two rather than iterating over bars. At the
 * minimum tempo and the largest signature a bar is 12 seconds long, and at 300 BPM in 2/4 it
 * is 400 ms; in both cases two candidates suffice, because the window is 50 ms and the
 * shortest possible bar is 400 ms.
 *
 * Each boundary is rounded to an integer millisecond (Requirement 28.3), and is rounded from
 * `n · barLength` rather than from a rounded bar length, so bar 200 is where the tempo says
 * it is rather than up to 100 ms away from it.
 *
 * ### Negative candidates are dropped
 *
 * A start time is a non-negative integer (28.3), so bar −1 and the end of a clip that
 * somehow sat before zero are not admissible destinations.
 */

import { SNAP_WINDOW_MS, barLengthMs } from './bounds';
import { clipEndTimeMs, type TimelineProject } from './project';

export type SnapCandidateKind = 'clip_start' | 'clip_end' | 'bar_boundary';

export interface SnapCandidate {
  readonly timeMs: number;
  readonly kind: SnapCandidateKind;
  /** The clip the candidate came from, for `clip_start` and `clip_end`. */
  readonly clipId?: string;
  /** The bar index, for `bar_boundary`. */
  readonly bar?: number;
}

export interface SnapOutcome {
  /** The start time to apply. */
  readonly startTimeMs: number;
  /** The winning candidate, or `null` when the requested time was used unchanged. */
  readonly candidate: SnapCandidate | null;
  /** Every candidate inside the window, for a UI that wants to show them. */
  readonly consideredCandidates: readonly SnapCandidate[];
}

/**
 * Requirement 28.21's candidate set, unfiltered by the window.
 *
 * Exposed because a timeline UI draws these as guide lines whether or not the pointer is
 * near one, and because a test that asserts "a project without a tempo offers no bar
 * boundaries" should be able to look at the set rather than infer it from an outcome.
 */
export function snapCandidates(
  project: TimelineProject,
  requestedStartTimeMs: number,
  movingClipId: string | null,
): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];

  for (const clip of project.clips) {
    if (clip.id === movingClipId) continue;
    candidates.push({ timeMs: clip.startTimeMs, kind: 'clip_start', clipId: clip.id });
    candidates.push({ timeMs: clipEndTimeMs(clip), kind: 'clip_end', clipId: clip.id });
  }

  const bar = barLengthMs(project.tempoBpm, project.timeSignature);
  if (bar !== null && bar > 0) {
    // Requirements 28.21/28.39: with no tempo (or no signature) there are zero bar
    // candidates, which is this branch simply not running.
    const nearestBelow = Math.floor(requestedStartTimeMs / bar);
    for (const index of [nearestBelow, nearestBelow + 1]) {
      if (index < 0) continue;
      candidates.push({ timeMs: Math.round(index * bar), kind: 'bar_boundary', bar: index });
    }
  }

  return candidates.filter((candidate) => candidate.timeMs >= 0);
}

/**
 * Requirement 28.21: the start time to apply for a requested move.
 *
 * `enabled` is the clause's `WHERE 스냅 기능이 활성화된 경우`. With snapping off the requested
 * time is returned untouched and no candidate is reported, which is a different outcome from
 * "snapping was on and nothing was near" only in `consideredCandidates` — deliberately, so a
 * caller can tell the two apart when reporting to a user.
 */
export function resolveSnappedStartTime(
  project: TimelineProject,
  requestedStartTimeMs: number,
  options: {
    readonly enabled: boolean;
    readonly movingClipId?: string | null;
    readonly windowMs?: number;
  },
): SnapOutcome {
  if (!options.enabled) {
    return {
      startTimeMs: requestedStartTimeMs,
      candidate: null,
      consideredCandidates: [],
    };
  }

  const windowMs = options.windowMs ?? SNAP_WINDOW_MS;
  const inWindow = snapCandidates(
    project,
    requestedStartTimeMs,
    options.movingClipId ?? null,
  ).filter((candidate) => Math.abs(candidate.timeMs - requestedStartTimeMs) <= windowMs);

  if (inWindow.length === 0) {
    return {
      startTimeMs: requestedStartTimeMs,
      candidate: null,
      consideredCandidates: [],
    };
  }

  // Nearest wins; on a tie the earlier time wins (28.21). `reduce` rather than a sort, so the
  // tie-break is a single explicit comparison rather than a consequence of sort stability —
  // which is not something to rely on for a rule the requirement states outright.
  const winner = inWindow.reduce((best, candidate) => {
    const bestDistance = Math.abs(best.timeMs - requestedStartTimeMs);
    const distance = Math.abs(candidate.timeMs - requestedStartTimeMs);
    if (distance < bestDistance) return candidate;
    if (distance > bestDistance) return best;
    return candidate.timeMs < best.timeMs ? candidate : best;
  });

  return { startTimeMs: winner.timeMs, candidate: winner, consideredCandidates: inWindow };
}
