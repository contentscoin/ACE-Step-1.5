/**
 * `LRC_Parser` (Requirements 10.3, 10.5, 10.6).
 *
 * Unlike `parseLyrics`, this parser can fail: Requirement 10.6 names a rejection
 * explicitly, so the result is a `ParseResult` carrying design §7.2 errors with
 * 1-based line numbers.
 *
 * Every malformed line is reported, not just the first. An LRC file produced by a
 * broken exporter is usually broken on many lines in the same way, and telling the
 * user about one line at a time turns one fix into many uploads.
 *
 * Ordering (Requirement 10.5) is established here rather than being assumed of the
 * input, and it is established with a **stable** sort — see `sortByTime` for why
 * ties must not be reordered.
 */

import { parseFailure, parseSuccess, type ParseError, type ParseResult, type ParseWarning } from '../parse-error';

import { readLrcLine } from './lrc-timestamp';
import { splitLyricsLines } from './document';
import { sortByTime, type TimedLyricLine, type TimedLyrics } from './timed-lyrics';

/** Requirement 10.6's violation codes, exported so callers branch on a token. */
export const LRC_TIMESTAMP_MALFORMED = 'lrc_timestamp_malformed';
export const LRC_TIMESTAMP_MISSING = 'lrc_timestamp_missing';
/** An LRC metadata tag (`[ti:…]`) was recognised and dropped. */
export const LRC_METADATA_IGNORED = 'lrc_metadata_tag_ignored';

const EXPECTED_TIMESTAMP = '[mm:ss.xx] at the start of the line';

export function parseLrc(text: string): ParseResult<TimedLyrics> {
  const lines: TimedLyricLine[] = [];
  const errors: ParseError[] = [];
  const warnings: ParseWarning[] = [];

  splitLyricsLines(text).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const reading = readLrcLine(rawLine);

    switch (reading.kind) {
      case 'blank':
        return;

      case 'metadata':
        // Kept out of Timed_Lyrics — no requirement models LRC metadata — but
        // reported, because dropping input silently is how data loss goes unnoticed.
        warnings.push({
          line: lineNumber,
          code: LRC_METADATA_IGNORED,
          message: `LRC metadata tag ${reading.tag} is not part of Timed_Lyrics and was ignored.`,
          actual: reading.tag,
        });
        return;

      case 'timed':
        lines.push({ startMs: reading.startMs, text: reading.text });
        return;

      case 'malformed_timestamp':
        errors.push({
          line: lineNumber,
          field: 'timestamp',
          violation: LRC_TIMESTAMP_MALFORMED,
          expected: EXPECTED_TIMESTAMP,
          actual: rawLine,
        });
        return;

      case 'missing_timestamp':
        errors.push({
          line: lineNumber,
          field: 'timestamp',
          violation: LRC_TIMESTAMP_MISSING,
          expected: EXPECTED_TIMESTAMP,
          actual: rawLine,
        });
        return;
    }
  });

  if (errors.length > 0) return parseFailure<TimedLyrics>(...errors);

  // Requirement 10.5: the *result* is ordered, whatever order the file was in.
  return parseSuccess(sortByTime({ lines }), warnings);
}
