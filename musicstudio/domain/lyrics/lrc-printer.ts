/**
 * `LRC_Printer` (Requirements 10.2, 10.8).
 *
 * One line per timed line: the `[mm:ss.xx]` field followed immediately by the text,
 * with no separator space (see `readLrcLine` for why the space is omitted rather
 * than being conventional-but-lossy).
 *
 * The printer does **not** reorder. Requirement 10.5 puts ordering on the parser, and
 * a valid `Timed_Lyrics` is already non-decreasing by construction (`sortByTime` is
 * where order is established). Sorting again here would make this a second place
 * where line order could silently change, and would hide a caller that had built an
 * unordered value.
 *
 * A trailing newline is emitted for a non-empty document, because the output is a
 * downloadable text file (Requirement 10.8) and a text file ends with one. The parser
 * ignores blank lines, so it cannot affect a subsequent parse.
 */

import { formatLrcTimestamp } from './lrc-timestamp';
import type { TimedLyrics } from './timed-lyrics';

export function printLrc(timedLyrics: TimedLyrics): string {
  if (timedLyrics.lines.length === 0) return '';
  return timedLyrics.lines
    .map((line) => `${formatLrcTimestamp(line.startMs)}${line.text}`)
    .join('\n')
    .concat('\n');
}
