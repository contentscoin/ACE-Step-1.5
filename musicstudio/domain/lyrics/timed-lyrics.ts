/**
 * `Timed_Lyrics` and its validity predicate (Requirements 10.4, 10.5, 10.7; §7.1).
 *
 * A timestamped line list, ordered by time. Nothing here knows where the timings
 * came from: Requirement 27.9 makes Transcription_Service the single source of
 * timing and Requirement 10.2/10.3 make this module's printer and parser the single
 * serialisation path, so the two concerns are kept apart on purpose.
 *
 * The track length is deliberately *not* a field. LRC text carries no duration, so
 * a duration stored on the struct could not survive a round trip and would make
 * Requirement 10.4 unsatisfiable; Requirement 10.7's bound is therefore checked
 * against a duration the caller supplies (`timedLyricsOutOfTrackBounds`).
 */

import type { ParseError } from '../parse-error';

export interface TimedLyricLine {
  /** Offset from the start of the track, in milliseconds. */
  readonly startMs: number;
  /** Line text, verbatim. Never contains a line terminator. */
  readonly text: string;
}

export interface TimedLyrics {
  readonly lines: readonly TimedLyricLine[];
}

export const EMPTY_TIMED_LYRICS: TimedLyrics = { lines: [] };

/**
 * Requirement 10.4's tolerance, and the reason it exists.
 *
 * `[mm:ss.xx]` resolves to a centisecond, so printing quantises. Rounding to the
 * nearest centisecond bounds the error at 5 ms — half the budget — which leaves
 * room for a future format change to `.xxx` without the guarantee moving.
 */
export const LRC_ROUND_TRIP_TOLERANCE_MS = 10;

/** Resolution of the `xx` field: one centisecond. */
export const LRC_TIMESTAMP_QUANTUM_MS = 10;

/**
 * Largest timestamp `[mm:ss.xx]` expresses with a two-digit minute field: 99:59.99.
 *
 * A multiple of the quantum on purpose, so rounding any accepted value can never
 * carry into a three-digit minute field and change the printed shape Requirement
 * 10.2 specifies.
 */
export const LRC_MAX_TIMESTAMP_MS = 99 * 60_000 + 59 * 1_000 + 990;

export type TimedLyricsDefect =
  | { readonly kind: 'timestamp_out_of_range'; readonly lineIndex: number; readonly startMs: number }
  | { readonly kind: 'timestamps_out_of_order'; readonly lineIndex: number }
  | { readonly kind: 'text_contains_line_break'; readonly lineIndex: number; readonly text: string };

/**
 * Every reason `timedLyrics` would not survive print-then-parse, or an empty list.
 *
 * As with `lyricsDocumentDefects`, each condition corresponds to a way the round
 * trip provably fails, and together they are the meaning of "유효한 Timed_Lyrics" in
 * Requirement 10.4.
 */
export function timedLyricsDefects(timedLyrics: TimedLyrics): readonly TimedLyricsDefect[] {
  const defects: TimedLyricsDefect[] = [];
  let previousStartMs = Number.NEGATIVE_INFINITY;

  timedLyrics.lines.forEach((line, lineIndex) => {
    if (
      !Number.isFinite(line.startMs) ||
      line.startMs < 0 ||
      line.startMs > LRC_MAX_TIMESTAMP_MS
    ) {
      defects.push({ kind: 'timestamp_out_of_range', lineIndex, startMs: line.startMs });
    }
    // Requirement 10.5 makes the parser's output ordered, so an unordered original
    // would come back permuted and could not match position for position.
    if (line.startMs < previousStartMs) {
      defects.push({ kind: 'timestamps_out_of_order', lineIndex });
    }
    previousStartMs = line.startMs;

    if (/[\r\n]/u.test(line.text)) {
      defects.push({ kind: 'text_contains_line_break', lineIndex, text: line.text });
    }
  });

  return defects;
}

export function isValidTimedLyrics(timedLyrics: TimedLyrics): boolean {
  return timedLyricsDefects(timedLyrics).length === 0;
}

/** Requirement 10.5's invariant, checkable on any candidate. */
export function isNonDecreasingByTime(timedLyrics: TimedLyrics): boolean {
  return timedLyrics.lines.every(
    (line, index) => index === 0 || line.startMs >= (timedLyrics.lines[index - 1]?.startMs ?? 0),
  );
}

/**
 * Returns `timedLyrics` with lines ordered by time, preserving the order of ties.
 *
 * Stability is load-bearing rather than incidental: centisecond quantisation can
 * map two distinct instants onto one timestamp, and two lines can legitimately
 * share an instant (a duet). If ties were reordered, printing and reparsing would
 * permute those lines and Requirement 10.4 would fail on inputs that are otherwise
 * perfectly well formed. `Array.prototype.sort` is specified as stable.
 */
export function sortByTime(timedLyrics: TimedLyrics): TimedLyrics {
  if (isNonDecreasingByTime(timedLyrics)) return timedLyrics;
  return { lines: [...timedLyrics.lines].sort((left, right) => left.startMs - right.startMs) };
}

/**
 * Requirement 10.7: every timestamp lies in `[0, trackDurationMs]`.
 *
 * Reported as `ParseError`s (design §7.2) with 1-based line numbers, so a caller can
 * tell the user which line is past the end of the track rather than only that
 * something is.
 */
export function timedLyricsOutOfTrackBounds(
  timedLyrics: TimedLyrics,
  trackDurationMs: number,
): readonly ParseError[] {
  const errors: ParseError[] = [];

  timedLyrics.lines.forEach((line, index) => {
    if (line.startMs < 0 || line.startMs > trackDurationMs) {
      errors.push({
        line: index + 1,
        field: 'startMs',
        violation: 'timestamp_outside_track',
        expected: `0..${String(trackDurationMs)} ms`,
        actual: String(line.startMs),
      });
    }
  });

  return errors;
}

export function isWithinTrackBounds(
  timedLyrics: TimedLyrics,
  trackDurationMs: number,
): boolean {
  return timedLyricsOutOfTrackBounds(timedLyrics, trackDurationMs).length === 0;
}
