import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { activeLineAt, withLineEnds } from '../../../domain/playback/lyrics-sync';
import type { TimedLyrics } from '../../../domain/lyrics/timed-lyrics';

/**
 * Lyric synchronisation.
 *
 * **Validates: Requirement 12.5**
 *
 * A `Timed_Lyrics` line carries a start and no end, so "the line at this position" is the
 * last line that has started. The two boundaries that matter: a position *exactly* on a
 * line's start already belongs to it, and a position before the first line belongs to no
 * line at all rather than to line zero — an intro is a real state, and showing the first line
 * over it would be wrong for exactly the assets that have one.
 */

const LYRICS: TimedLyrics = {
  lines: [
    { startMs: 1_000, text: 'first' },
    { startMs: 3_000, text: 'second' },
    { startMs: 7_500, text: 'third' },
  ],
};

describe('activeLineAt (Requirement 12.5)', () => {
  it('shows no line during the intro', () => {
    expect(activeLineAt(LYRICS, 0)).toBeNull();
    expect(activeLineAt(LYRICS, 999)).toBeNull();
  });

  it('shows a line from its own start, inclusively', () => {
    expect(activeLineAt(LYRICS, 1_000)).toEqual({
      index: 0,
      startMs: 1_000,
      text: 'first',
      endMs: 3_000,
    });
  });

  it('keeps a line until the next one starts', () => {
    expect(activeLineAt(LYRICS, 2_999)?.text).toBe('first');
    expect(activeLineAt(LYRICS, 3_000)?.text).toBe('second');
  });

  it('leaves the last line open-ended', () => {
    expect(activeLineAt(LYRICS, 7_500)).toEqual({
      index: 2,
      startMs: 7_500,
      text: 'third',
      endMs: null,
    });
    expect(activeLineAt(LYRICS, 9_999_999)?.text).toBe('third');
  });

  it('shows no line for empty lyrics', () => {
    expect(activeLineAt({ lines: [] }, 5_000)).toBeNull();
  });

  it('sorts before searching, rather than trusting the input order', () => {
    // `Timed_Lyrics` also arrives from `Transcription_Service` and from a user edit, and a
    // binary search over an unsorted list returns a plausible wrong answer.
    const shuffled: TimedLyrics = {
      lines: [
        { startMs: 7_500, text: 'third' },
        { startMs: 1_000, text: 'first' },
        { startMs: 3_000, text: 'second' },
      ],
    };

    expect(activeLineAt(shuffled, 4_000)?.text).toBe('second');
    expect(activeLineAt(shuffled, 500)).toBeNull();
  });
});

describe('withLineEnds', () => {
  it('gives every line the end its successor implies', () => {
    expect(withLineEnds(LYRICS)).toEqual([
      { index: 0, startMs: 1_000, text: 'first', endMs: 3_000 },
      { index: 1, startMs: 3_000, text: 'second', endMs: 7_500 },
      { index: 2, startMs: 7_500, text: 'third', endMs: null },
    ]);
  });

  it('agrees with activeLineAt at every line start', () => {
    for (const line of withLineEnds(LYRICS)) {
      expect(activeLineAt(LYRICS, line.startMs)).toEqual(line);
    }
  });
});

describe('synchronisation invariants', () => {
  const lyricsArbitrary = fc
    .uniqueArray(fc.integer({ min: 0, max: 300_000 }), { minLength: 1, maxLength: 40 })
    .map((starts): TimedLyrics => ({
      lines: [...starts]
        .sort((left, right) => left - right)
        .map((startMs, index) => ({ startMs, text: `line-${String(index)}` })),
    }));

  it('never shows a line that has not started', () => {
    fc.assert(
      fc.property(lyricsArbitrary, fc.integer({ min: -1_000, max: 400_000 }), (lyrics, positionMs) => {
        const active = activeLineAt(lyrics, positionMs);
        if (active === null) return true;

        expect(active.startMs).toBeLessThanOrEqual(positionMs);
        if (active.endMs !== null) expect(active.endMs).toBeGreaterThan(positionMs);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('shows a line at every position from the first start onwards, with no gap', () => {
    fc.assert(
      fc.property(lyricsArbitrary, (lyrics) => {
        const first = lyrics.lines[0];
        if (first === undefined) return true;

        for (const line of withLineEnds(lyrics)) {
          expect(activeLineAt(lyrics, line.startMs)?.index).toBe(line.index);
          if (line.endMs !== null) {
            expect(activeLineAt(lyrics, line.endMs - 1)?.index).toBe(line.index);
          }
        }
        expect(activeLineAt(lyrics, first.startMs - 1)).toBeNull();
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
