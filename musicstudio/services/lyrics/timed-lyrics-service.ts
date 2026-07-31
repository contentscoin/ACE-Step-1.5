/**
 * Serves a track's Timed_Lyrics as LRC (Requirements 10.5, 10.7, 10.8).
 *
 * The only path from stored timings to LRC text. It does three things and no more:
 * order the lines, check Requirement 10.7's bound, and print.
 *
 * **Why an out-of-bounds timestamp is refused rather than clamped.** Requirement 10.7
 * says the timestamps *are kept* within `0..track length`. Clamping would satisfy the
 * letter of that while silently moving a line the transcription placed elsewhere, and
 * dropping the line would silently lose lyric text. Both hide a broken timing source;
 * refusing surfaces it, with the offending line numbers, so the fault is fixed where
 * it was introduced (Requirement 27.9's Transcription_Service) rather than papered
 * over here.
 */

import { printLrc } from '../../domain/lyrics/lrc-printer';
import {
  sortByTime,
  timedLyricsOutOfTrackBounds,
  type TimedLyrics,
} from '../../domain/lyrics/timed-lyrics';
import type { ParseError } from '../../domain/parse-error';

import type { TimedLyricsSourcePort } from './timing-port';

export interface TimedLyricsRequest {
  readonly trackId: string;
  /** Track length in milliseconds — Requirement 10.7's upper bound. */
  readonly trackDurationMs: number;
}

export type TimedLyricsOutcome =
  | {
      readonly kind: 'available';
      readonly timedLyrics: TimedLyrics;
      /** Requirement 10.8's file body. */
      readonly lrc: string;
      readonly fileName: string;
    }
  /** The track has no Timed_Lyrics: instrumental, or not transcribed yet. */
  | { readonly kind: 'unavailable' }
  /** Requirement 10.7 violated by the stored timings, per offending line. */
  | { readonly kind: 'out_of_bounds'; readonly errors: readonly ParseError[] };

export interface TimedLyricsService {
  lrcFor(request: TimedLyricsRequest): Promise<TimedLyricsOutcome>;
}

export function createTimedLyricsService(options: {
  readonly source: TimedLyricsSourcePort;
}): TimedLyricsService {
  return {
    async lrcFor(request) {
      const lines = await options.source.timingsFor(request.trackId);
      if (lines === null || lines.length === 0) return { kind: 'unavailable' };

      // Requirement 10.5's ordering is established once, here, so the printed file
      // and the value handed to a lyric-video renderer are the same ordering.
      const timedLyrics = sortByTime({ lines });

      const errors = timedLyricsOutOfTrackBounds(timedLyrics, request.trackDurationMs);
      if (errors.length > 0) return { kind: 'out_of_bounds', errors };

      return {
        kind: 'available',
        timedLyrics,
        lrc: printLrc(timedLyrics),
        fileName: `${request.trackId}.lrc`,
      };
    },
  };
}
