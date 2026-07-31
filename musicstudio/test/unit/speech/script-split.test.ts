import { describe, expect, it } from 'vitest';

import {
  SENTENCE_TERMINATORS,
  SPLIT_THRESHOLD_DEFAULT,
} from '../../../domain/speech/bounds';
import {
  cutsAtPermittedPositions,
  eligibleCutPositions,
  isContiguousInOrder,
  joinChunks,
  respectsSentenceCount,
  splitScript,
} from '../../../domain/speech/script-split';
import { validateDialogueRequest } from '../../../domain/speech/validation';

/**
 * Script splitting (Requirements 25.10, 25.11, 25.12, 25.13).
 *
 * **Validates: Requirements 25.10, 25.11, 25.12, 25.13**
 *
 * The examples here pin the behaviour the property test in
 * `test/property/dialogue-generation.test.ts` then generalises: the round trip, the count bound and
 * the permitted cut positions are all asserted over generated scripts there, and asserted on
 * specific shapes here — the overshoot case, the blank-line run, the CRLF script — because a
 * generator is unlikely to produce exactly those and a reader needs to see them.
 */

describe('the default threshold (Requirement 25.10)', () => {
  it('is 800 characters', () => {
    expect(SPLIT_THRESHOLD_DEFAULT).toBe(800);
  });

  it('leaves a script inside the threshold as one chunk', () => {
    const split = splitScript('One. Two. Three.');

    expect(split.chunks).toHaveLength(1);
    expect(split.chunks[0]?.text).toBe('One. Two. Three.');
    expect(split.thresholdChars).toBe(800);
  });
});

describe('cut positions (Requirement 25.11)', () => {
  it('names exactly the positions after a newline or a sentence terminator', () => {
    // `a.` at 0..1, so 2 is eligible; `\n` at 4, so 5 is; `?` at 7, so 8 is.
    expect(eligibleCutPositions('a.b\nc?d')).toEqual([2, 4, 6]);
  });

  it('treats all four terminators of 25.11 as eligible', () => {
    for (const terminator of SENTENCE_TERMINATORS) {
      expect(eligibleCutPositions(`a${terminator}b`)).toEqual([2]);
    }
    expect(SENTENCE_TERMINATORS).toEqual(['.', '?', '!', '。']);
  });

  it('does not treat a comma or a colon as a boundary', () => {
    expect(eligibleCutPositions('a,b:c;d')).toEqual([]);
  });

  it('never cuts between the halves of a CRLF line ending', () => {
    const split = splitScript('one.\r\ntwo.\r\nthree.', { thresholdChars: 6 });

    expect(cutsAtPermittedPositions(split)).toBe(true);
    for (const chunk of split.chunks) {
      expect(chunk.text.startsWith('\n')).toBe(false);
    }
  });

  it('splits at a line boundary when one is available inside the threshold', () => {
    const split = splitScript('aaaa\nbbbb\ncccc', { thresholdChars: 6 });

    expect(joinChunks(split)).toBe('aaaa\nbbbb\ncccc');
    expect(cutsAtPermittedPositions(split)).toBe(true);
    expect(split.chunks.length).toBeGreaterThan(1);
  });

  it('takes the last eligible position within the threshold, not the first', () => {
    // Eligible at 3, 6, 9. With a threshold of 7 the walk must reach 6 rather than stop at 3.
    const split = splitScript('aa.bb.cc.dd', { thresholdChars: 7 });

    expect(split.chunks[0]?.text).toBe('aa.bb.');
  });
});

describe('the overshoot case (Requirement 25.11)', () => {
  it('produces one over-long chunk when the script has no permitted cut at all', () => {
    const script = 'x'.repeat(500);
    const split = splitScript(script, { thresholdChars: 100 });

    // 25.11 permits a cut nowhere else, so an over-long chunk is the only legal answer.
    expect(split.chunks).toHaveLength(1);
    expect(split.chunks[0]?.text).toHaveLength(500);
    expect(joinChunks(split)).toBe(script);
  });

  it('takes the first eligible position past the threshold, keeping the overshoot minimal', () => {
    // The only eligible position is 301 (after the period), well past a threshold of 50.
    const script = `${'x'.repeat(300)}.${'y'.repeat(300)}`;
    const split = splitScript(script, { thresholdChars: 50 });

    expect(split.chunks).toHaveLength(2);
    expect(split.chunks[0]?.text).toHaveLength(301);
    expect(joinChunks(split)).toBe(script);
  });
});

describe('order is preserved as a round trip (Requirement 25.12)', () => {
  it('reassembles the script exactly, for a script with every kind of boundary', () => {
    const script = 'First.\nSecond? Third! 네번째。\n\nFifth.';
    const split = splitScript(script, { thresholdChars: 100 });

    expect(joinChunks(split)).toBe(script);
    expect(isContiguousInOrder(split)).toBe(true);
    expect(split.chunks.map((chunk) => chunk.index)).toEqual(
      split.chunks.map((_chunk, index) => index),
    );
  });

  it('holds for the empty script, which yields no chunks', () => {
    const split = splitScript('');

    expect(split.chunks).toEqual([]);
    expect(joinChunks(split)).toBe('');
    expect(isContiguousInOrder(split)).toBe(true);
  });
});

describe('the chunk count never exceeds the sentence count (Requirement 25.13)', () => {
  it('merges a run of blank lines rather than making each one a chunk', () => {
    // Without merging this would be four chunks against two text-bearing units.
    const script = 'a.\n\n\nb.';
    const split = splitScript(script, { thresholdChars: 1 });

    expect(joinChunks(split)).toBe(script);
    expect(split.sentenceCount).toBe(2);
    expect(split.chunks.length).toBeLessThanOrEqual(split.sentenceCount);
    expect(respectsSentenceCount(split)).toBe(true);
    for (const chunk of split.chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('counts only units that carry text', () => {
    expect(splitScript('a.\n').sentenceCount).toBe(1);
    expect(splitScript('a. b. c.').sentenceCount).toBe(3);
    expect(splitScript('   ').sentenceCount).toBe(1);
    expect(splitScript('').sentenceCount).toBe(0);
  });

  it('holds for a whitespace-only script longer than the threshold', () => {
    const split = splitScript('\n'.repeat(50), { thresholdChars: 2 });

    expect(respectsSentenceCount(split)).toBe(true);
    expect(split.chunks).toHaveLength(1);
  });

  /**
   * The one case where a chunk carries no text, pinned rather than left to be discovered.
   *
   * A script of nothing but whitespace has no text-bearing unit to cut at, so the only answer that
   * keeps 25.12's round trip intact is a single chunk holding the whitespace — returning no chunks
   * would lose characters. It is unreachable through the service: Requirement 25.4 measures the
   * script trimmed and refuses this input before the splitter is called, which is why the
   * corresponding property in `test/property/dialogue-generation.test.ts` carries that precondition.
   */
  it('returns the whitespace as one chunk for an all-whitespace script, keeping the round trip', () => {
    const split = splitScript('  ', { thresholdChars: 1 });

    expect(split.chunks.map((chunk) => chunk.text)).toEqual(['  ']);
    expect(joinChunks(split)).toBe('  ');
    expect(respectsSentenceCount(split)).toBe(true);
    // Such a script never reaches here: 25.4 refuses it. See `validateDialogueRequest`.
    expect(validateDialogueRequest({ script: '  ', voiceProfileId: 'vp', languageCode: 'ko' }).kind)
      .toBe('invalid');
  });
});

describe('every chunk carries text', () => {
  it('never yields an empty chunk, for any threshold', () => {
    for (const thresholdChars of [1, 2, 5, 11, 100]) {
      const split = splitScript('one.\ntwo.\n\nthree.\nfour.', { thresholdChars });
      for (const chunk of split.chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
      expect(respectsSentenceCount(split)).toBe(true);
    }
  });
});
