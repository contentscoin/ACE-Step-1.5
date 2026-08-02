/**
 * Which lyric line is showing (Requirement 12.5).
 *
 * "현재 재생 위치에 대응하는 가사 행" — a `Timed_Lyrics` line carries a start time and no
 * end, so the line for a position is the last one that has started. That reading is what
 * makes the display continuous: every position from a line's start until the next line's
 * belongs to it, with no gap where nothing is shown.
 *
 * Before the first line's start there is no line, which is a real state — an intro — and is
 * reported as `null` rather than as line zero. Showing the first line over the intro would
 * be wrong for exactly the assets that have one.
 */

import { sortByTime, type TimedLyrics } from '../lyrics/timed-lyrics';

export interface ActiveLyricLine {
  readonly index: number;
  readonly startMs: number;
  readonly text: string;
  /** When this line gives way to the next. `null` for the last line. */
  readonly endMs: number | null;
}

/**
 * The line showing at `positionMs`, or `null` before the first one starts.
 *
 * Sorts first rather than trusting the input's order. `LRC_Parser` guarantees ascending
 * order (Requirement 10.5, Property 5) but `Timed_Lyrics` also arrives from
 * `Transcription_Service` and from a user edit, and a binary search over an unsorted list
 * returns a plausible wrong answer rather than an obvious one.
 */
export function activeLineAt(timedLyrics: TimedLyrics, positionMs: number): ActiveLyricLine | null {
  const lines = sortByTime(timedLyrics).lines;
  if (lines.length === 0) return null;

  let low = 0;
  let high = lines.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const line = lines[middle];
    if (line === undefined) break;

    if (line.startMs <= positionMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (found < 0) return null;

  const line = lines[found];
  if (line === undefined) return null;
  const next = lines[found + 1];

  return {
    index: found,
    startMs: line.startMs,
    text: line.text,
    endMs: next?.startMs ?? null,
  };
}

/**
 * Every line, each with the end its successor implies.
 *
 * For a client that renders the whole lyric and highlights as it plays: doing this once
 * beats calling `activeLineAt` on every animation frame, and it keeps the "ends where the
 * next begins" rule in one place rather than in each caller that needed a duration.
 */
export function withLineEnds(timedLyrics: TimedLyrics): readonly ActiveLyricLine[] {
  const lines = sortByTime(timedLyrics).lines;
  return lines.map((line, index) => ({
    index,
    startMs: line.startMs,
    text: line.text,
    endMs: lines[index + 1]?.startMs ?? null,
  }));
}
