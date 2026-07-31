import { describe, expect, it } from 'vitest';

import {
  LRC_METADATA_IGNORED,
  LRC_TIMESTAMP_MALFORMED,
  LRC_TIMESTAMP_MISSING,
  parseLrc,
} from '../../../domain/lyrics/lrc-parser';
import { printLrc } from '../../../domain/lyrics/lrc-printer';
import { formatLrcTimestamp } from '../../../domain/lyrics/lrc-timestamp';
import {
  EMPTY_TIMED_LYRICS,
  LRC_MAX_TIMESTAMP_MS,
  timedLyricsDefects,
  type TimedLyrics,
} from '../../../domain/lyrics/timed-lyrics';

/**
 * `LRC_Printer` / `LRC_Parser` worked examples (Requirements 10.2, 10.3, 10.5, 10.6).
 *
 * Properties 4 and 5 cover the universal claims. These pin the printed shape byte for
 * byte, and pin Requirement 10.6's rejection — which is an assertion about a *payload*
 * (a line number and a violation), and so cannot be a property.
 */

function parsedLines(text: string): readonly { startMs: number; text: string }[] {
  const result = parseLrc(text);
  if (!result.ok) throw new Error(`expected a successful parse: ${JSON.stringify(result.errors)}`);
  return result.value.lines;
}

describe('Requirement 10.2 — the printed timestamp is [mm:ss.xx]', () => {
  it('pads every field to two digits', () => {
    expect(formatLrcTimestamp(0)).toBe('[00:00.00]');
    expect(formatLrcTimestamp(1_000)).toBe('[00:01.00]');
    expect(formatLrcTimestamp(90_120)).toBe('[01:30.12]');
    expect(formatLrcTimestamp(9 * 60_000 + 5 * 1_000 + 70)).toBe('[09:05.07]');
  });

  it('keeps two minute digits at the top of the range', () => {
    expect(formatLrcTimestamp(LRC_MAX_TIMESTAMP_MS)).toBe('[99:59.99]');
  });

  it('rounds to the nearest centisecond', () => {
    expect(formatLrcTimestamp(1_004)).toBe('[00:01.00]');
    expect(formatLrcTimestamp(1_005)).toBe('[00:01.01]');
    expect(formatLrcTimestamp(1_006)).toBe('[00:01.01]');
    // Rounding up carries into the seconds field, and then into the minutes field.
    expect(formatLrcTimestamp(1_999)).toBe('[00:02.00]');
    expect(formatLrcTimestamp(59_999)).toBe('[01:00.00]');
  });

  it('writes the timestamp immediately before the text, with no separator', () => {
    expect(printLrc({ lines: [{ startMs: 1_500, text: 'hello' }] })).toBe('[00:01.50]hello\n');
  });

  it('prints an empty Timed_Lyrics as an empty string', () => {
    expect(printLrc(EMPTY_TIMED_LYRICS)).toBe('');
  });

  it('ends a non-empty file with a newline', () => {
    expect(
      printLrc({ lines: [{ startMs: 0, text: 'a' }, { startMs: 1_000, text: 'b' }] }),
    ).toBe('[00:00.00]a\n[00:01.00]b\n');
  });
});

describe('Requirement 10.3 — LRC text becomes Timed_Lyrics', () => {
  it('reads the timestamp and keeps the rest of the line as text', () => {
    expect(parsedLines('[00:01.50]hello\n[01:00.00]world')).toEqual([
      { startMs: 1_500, text: 'hello' },
      { startMs: 60_000, text: 'world' },
    ]);
  });

  it('keeps the text verbatim, including leading and trailing whitespace', () => {
    // A conventional file writes `[00:01.00] hello`. Trimming would be convenient and
    // lossy: a lyric that genuinely starts with a space could never come back.
    expect(parsedLines('[00:01.00] hello ')).toEqual([{ startMs: 1_000, text: ' hello ' }]);
  });

  it('accepts a one-digit minute field and a three-digit fraction', () => {
    expect(parsedLines('[1:02.50]x')).toEqual([{ startMs: 62_500, text: 'x' }]);
    expect(parsedLines('[1:02.505]x')).toEqual([{ startMs: 62_505, text: 'x' }]);
  });

  it('accepts a colon as the fraction separator, which some tools emit', () => {
    expect(parsedLines('[00:12:34]x')).toEqual([{ startMs: 12_340, text: 'x' }]);
  });

  it('accepts a timestamp with no fraction at all', () => {
    expect(parsedLines('[02:03]x')).toEqual([{ startMs: 123_000, text: 'x' }]);
  });

  it('consumes only the first timestamp, leaving a second one as text', () => {
    // Not a supported form, and reading only the first bracket is what lets a line
    // whose text is genuinely bracket-shaped survive the round trip.
    expect(parsedLines('[00:10.00][01:20.00]chorus')).toEqual([
      { startMs: 10_000, text: '[01:20.00]chorus' },
    ]);
  });

  it('skips blank lines', () => {
    expect(parsedLines('\n[00:01.00]a\n   \n\t\n[00:02.00]b\n')).toHaveLength(2);
  });

  it('tolerates whitespace before the bracket', () => {
    expect(parsedLines('   [00:01.00]a')).toEqual([{ startMs: 1_000, text: 'a' }]);
  });
});

describe('Requirement 10.5 — the parse result is ordered by time', () => {
  it('sorts a file written out of order', () => {
    expect(parsedLines('[00:03.00]c\n[00:01.00]a\n[00:02.00]b').map((line) => line.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps the file order of lines that share a timestamp', () => {
    // Two lines can legitimately land on the same centisecond. Reordering them would
    // permute a duet, and would break the Requirement 10.4 round trip.
    expect(
      parsedLines('[00:01.00]first\n[00:01.00]second\n[00:01.00]third').map((line) => line.text),
    ).toEqual(['first', 'second', 'third']);
  });
});

describe('Requirement 10.6 — a malformed timestamp line is rejected with its line number', () => {
  it('names the 1-based line number and the violation', () => {
    const result = parseLrc('[00:01.00]a\n[oops]b\n[00:03.00]c');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');

    expect(result.errors).toEqual([
      {
        line: 2,
        field: 'timestamp',
        violation: LRC_TIMESTAMP_MALFORMED,
        expected: '[mm:ss.xx] at the start of the line',
        actual: '[oops]b',
      },
    ]);
  });

  it('reports a line with no timestamp at all', () => {
    const result = parseLrc('[00:01.00]a\nnaked lyric line');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors[0]?.violation).toBe(LRC_TIMESTAMP_MISSING);
    expect(result.errors[0]?.line).toBe(2);
  });

  it('reports every malformed line, not only the first', () => {
    const result = parseLrc('[bad]a\n[00:01.00]ok\n[worse]b\nno timestamp');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.map((error) => error.line)).toEqual([1, 3, 4]);
  });

  it('rejects a seconds field of 60 or more', () => {
    for (const text of ['[00:60.00]a', '[00:99.00]a']) {
      expect(parseLrc(text).ok).toBe(false);
    }
  });

  it('rejects a fraction that is neither two nor three digits', () => {
    for (const text of ['[00:01.0]a', '[00:01.0000]a']) {
      expect(parseLrc(text).ok).toBe(false);
    }
  });

  it('counts the line number across \\r\\n line endings', () => {
    const result = parseLrc('[00:01.00]a\r\n[00:02.00]b\r\n[nope]c');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors[0]?.line).toBe(3);
  });
});

describe('LRC metadata tags', () => {
  it('are recognised, dropped and reported rather than treated as malformed', () => {
    // `[ti:…]` is well-formed LRC; failing Requirement 10.6 on it would reject real
    // files for a fault they do not have.
    const result = parseLrc('[ti:A Title]\n[ar:An Artist]\n[00:01.00]a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.value.lines).toEqual([{ startMs: 1_000, text: 'a' }]);
    expect(result.warnings.map((warning) => ({ line: warning.line, code: warning.code }))).toEqual([
      { line: 1, code: LRC_METADATA_IGNORED },
      { line: 2, code: LRC_METADATA_IGNORED },
    ]);
  });

  it('never shadow a timestamp, because a timestamp opens with a digit', () => {
    expect(parsedLines('[00:01.00]a')).toHaveLength(1);
  });
});

describe('Timed_Lyrics validity states exactly what the printer can round-trip', () => {
  it('accepts an ordered list within the range', () => {
    const valid: TimedLyrics = {
      lines: [
        { startMs: 0, text: 'a' },
        { startMs: 0, text: 'tie' },
        { startMs: LRC_MAX_TIMESTAMP_MS, text: 'z' },
      ],
    };
    expect(timedLyricsDefects(valid)).toEqual([]);
  });

  it('rejects a timestamp past the two-digit-minute ceiling', () => {
    expect(
      timedLyricsDefects({ lines: [{ startMs: LRC_MAX_TIMESTAMP_MS + 10, text: 'a' }] }),
    ).toEqual([
      {
        kind: 'timestamp_out_of_range',
        lineIndex: 0,
        startMs: LRC_MAX_TIMESTAMP_MS + 10,
      },
    ]);
  });

  it('rejects a negative timestamp and an out-of-order line', () => {
    const defects = timedLyricsDefects({
      lines: [
        { startMs: 5_000, text: 'a' },
        { startMs: -1, text: 'b' },
      ],
    });
    expect(defects.map((defect) => defect.kind)).toEqual([
      'timestamp_out_of_range',
      'timestamps_out_of_order',
    ]);
  });

  it('rejects text containing a line break, which would split into two lines', () => {
    expect(timedLyricsDefects({ lines: [{ startMs: 0, text: 'a\nb' }] })).toEqual([
      { kind: 'text_contains_line_break', lineIndex: 0, text: 'a\nb' },
    ]);
  });
});
