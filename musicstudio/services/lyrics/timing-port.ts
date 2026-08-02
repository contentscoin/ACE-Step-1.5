/**
 * Where a track's line timings come from (Requirements 10.1, 27.9).
 *
 * Requirement 27.9 makes Transcription_Service the *only* source of line timings, and
 * Requirements 10.2/10.3 make this package's printer and parser the *only*
 * serialisation path. This port is the seam between those two statements, and it is
 * why task 2.3 does not implement transcription: Transcription_Service is task 2.7,
 * and a second timing source built here would contradict Requirement 27.9 the moment
 * it existed.
 *
 * Requirement 10.1's *trigger* — generating Timed_Lyrics when a vocal Track finishes
 * — likewise belongs to task 2.7, which owns the completion hook and the timings it
 * writes. What lives here is the read side: given a track, produce the LRC.
 */

import type { TimedLyricLine } from '../../domain/lyrics/timed-lyrics';

export interface TimedLyricsSourcePort {
  /**
   * The stored line timings for a track, or `null` when the track has none —
   * an instrumental track, or one whose transcription has not been produced yet.
   *
   * Order is not assumed: `TimedLyricsService` sorts, so a source that returns lines
   * in transcription order rather than time order cannot break Requirement 10.5.
   */
  timingsFor(trackId: string): Promise<readonly TimedLyricLine[] | null>;
}
