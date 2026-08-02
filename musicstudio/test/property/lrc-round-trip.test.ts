import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { timedLyricsEquivalent } from '../../domain/lyrics/equivalence';
import { parseLrc } from '../../domain/lyrics/lrc-parser';
import { printLrc } from '../../domain/lyrics/lrc-printer';
import { formatLrcTimestamp } from '../../domain/lyrics/lrc-timestamp';
import {
  isNonDecreasingByTime,
  timedLyricsDefects,
  LRC_MAX_TIMESTAMP_MS,
  LRC_ROUND_TRIP_TOLERANCE_MS,
  type TimedLyricLine,
  type TimedLyrics,
} from '../../domain/lyrics/timed-lyrics';

/**
 * Design §10 Properties 4–5 — `LRC_Parser` / `LRC_Printer` (design §7.1, §7.2).
 *
 * Equivalence is `timedLyricsEquivalent`: timestamps within ±10 ms and identical text,
 * exactly as §7.1 states it. Deep equality would be the *wrong* relation here — it
 * would contradict Requirement 10.4, which grants the tolerance because `[mm:ss.xx]`
 * cannot express a millisecond.
 *
 * As in the lyrics suite, validity is not a convenience: `timedLyricsDefects` lists the
 * conditions under which the round trip provably fails (a timestamp past the
 * two-digit-minute ceiling, an out-of-order line, an embedded line break), and each
 * property asserts the generator stayed inside that set.
 */

const NUM_RUNS = 200;

/**
 * Line text, including the awkward cases.
 *
 * The bracket-prefixed variants are the point: the printer emits the timestamp
 * immediately followed by the text, so text beginning with something bracket-shaped is
 * where a parser that consumed *more* than the first timestamp would lose data.
 */
const arbLineText = fc.oneof(
  { weight: 5, arbitrary: fc
      .array(
        fc.constantFrom(
          ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          ...' \t',
          ...'가나다라마',
          ...".,!?'-",
        ),
        { maxLength: 40 },
      )
      .map((chars) => chars.join('')) },
  { weight: 1, arbitrary: fc.constantFrom(
      '',
      ' leading space kept verbatim',
      'trailing space kept ',
      '[00:01.00]not a second timestamp',
      '[ti:not metadata here]',
      '[Verse]',
      '[]',
    ) },
);

/**
 * Timestamps in milliseconds, integral and fractional.
 *
 * Fractional values matter because printing rounds to a centisecond: they are what
 * actually exercises Requirement 10.4's tolerance rather than hitting it exactly.
 */
const arbStartMs = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: LRC_MAX_TIMESTAMP_MS }) },
  { weight: 2, arbitrary: fc.double({ min: 0, max: LRC_MAX_TIMESTAMP_MS, noNaN: true }) },
  // Straddles the rounding boundary in both directions, and both ends of the range.
  { weight: 1, arbitrary: fc.constantFrom(0, 4, 5, 6, 9, 14, 15, 994, 995, 999, 59_995, LRC_MAX_TIMESTAMP_MS) },
);

const arbTimedLine: fc.Arbitrary<TimedLyricLine> = fc.record({
  startMs: arbStartMs,
  text: arbLineText,
});

/**
 * A valid `Timed_Lyrics`: non-decreasing by time.
 *
 * The sort is stable, so lines generated with equal timestamps keep their generated
 * order — which is what the round trip then has to preserve.
 */
const arbTimedLyrics: fc.Arbitrary<TimedLyrics> = fc
  .array(arbTimedLine, { maxLength: 16 })
  .map((lines) => ({ lines: [...lines].sort((left, right) => left.startMs - right.startMs) }));

describe('Feature: ai-music-generation-service, Property 4: 유효한 Timed_Lyrics를 LRC_Printer로 출력한 후 LRC_Parser로 재파싱한 결과는 원본과 모든 타임스탬프 차이가 10ms 이내이다', () => {
  /**
   * **Validates: Requirements 10.4**
   */
  it('print then parse stays within 10 ms and keeps every line text, for every valid Timed_Lyrics', () => {
    fc.assert(
      fc.property(arbTimedLyrics, (original) => {
        expect(timedLyricsDefects(original)).toEqual([]);

        const result = parseLrc(printLrc(original));
        if (!result.ok) {
          throw new Error(`printed LRC failed to parse: ${JSON.stringify(result.errors)}`);
        }

        const verdict = timedLyricsEquivalent(original, result.value);
        if (!verdict.equivalent) throw new Error(`Timed_Lyrics differ: ${verdict.reason}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('quantises to a centisecond, so the drift is at most half the budget', () => {
    // Tighter than Requirement 10.4 demands, and asserted separately so that a change
    // from rounding to truncation — which would still satisfy 10.4 — is visible.
    fc.assert(
      fc.property(arbTimedLyrics, (original) => {
        const result = parseLrc(printLrc(original));
        if (!result.ok) throw new Error('printed LRC failed to parse');

        original.lines.forEach((line, index) => {
          const drift = Math.abs(line.startMs - (result.value.lines[index]?.startMs ?? NaN));
          expect(drift).toBeLessThanOrEqual(LRC_ROUND_TRIP_TOLERANCE_MS / 2);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/**
 * Deliberately unordered LRC text, plus the lines a real file carries around the
 * lyrics: metadata tags and blanks.
 *
 * Unordered on purpose — Requirement 10.5 is a claim about the parser's *output*, so a
 * generator that only produced sorted files would make the property vacuous.
 */
const arbShuffledLrcText = fc
  .array(arbTimedLine, { maxLength: 16 })
  .chain((lines) =>
    fc.tuple(
      fc.shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length }),
      fc.array(
        fc.constantFrom('[ti:A Title]', '[ar:An Artist]', '[offset:+250]', '', '   '),
        { maxLength: 4 },
      ),
      fc.constantFrom('\n', '\r\n'),
    ),
  )
  .map(([lines, extras, terminator]) =>
    [...extras, ...lines.map((line) => `${formatLrcTimestamp(line.startMs)}${line.text}`)].join(
      terminator,
    ),
  );

describe('Feature: ai-music-generation-service, Property 5: LRC_Parser의 파싱 결과에 대해 타임스탬프는 시간 오름차순으로 정렬되어 있다', () => {
  /**
   * **Validates: Requirements 10.5**
   *
   * "오름차순" is read as non-decreasing rather than strictly increasing, and that is
   * forced by the format: centisecond resolution can map two distinct instants onto one
   * timestamp, and two lines can legitimately share an instant. A strict reading would
   * make the invariant unsatisfiable for well-formed input.
   */
  it('returns lines in time order however the file was ordered', () => {
    fc.assert(
      fc.property(arbShuffledLrcText, (text) => {
        const result = parseLrc(text);
        if (!result.ok) {
          throw new Error(`well-formed LRC failed to parse: ${JSON.stringify(result.errors)}`);
        }

        expect(isNonDecreasingByTime(result.value)).toBe(true);
        // Spelled out rather than left to the helper, so the invariant is legible here.
        const timestamps = result.value.lines.map((line) => line.startMs);
        expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
