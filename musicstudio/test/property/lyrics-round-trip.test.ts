import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  countPlainTextLyricLines,
  isValidLyricsDocument,
  lyricsDocumentDefects,
  lyricsLineCount,
  type LyricsDocument,
  type LyricsSection,
} from '../../domain/lyrics/document';
import { lyricsDocumentsEquivalent } from '../../domain/lyrics/equivalence';
import { parseLyrics } from '../../domain/lyrics/lyrics-parser';
import { printLyrics } from '../../domain/lyrics/lyrics-printer';
import {
  classifyTagLabel,
  isTagLine,
  isEmptyLyricLine,
  LEADING_SECTION,
  RECOGNISED_LYRICS_SECTIONS,
  type LyricsSectionType,
} from '../../domain/lyrics/section-type';

/**
 * Design §10 Properties 1–3 — `Lyrics_Parser` / `Lyrics_Printer` (design §7.1, §7.3).
 *
 * Equivalence is judged by `lyricsDocumentsEquivalent`, the relation §7.1 names
 * (section order, section kind, line content), not by deep equality — see that
 * module for why the distinction matters.
 *
 * The generators are constrained rather than filtered wholesale: a lyric line is
 * *built* so that it is neither blank nor tag-shaped, and a custom label is built so
 * that it reprints as itself. Those constraints are not conveniences to dodge
 * failures — they are the definition of "유효한 Lyrics_Document" that Requirement 9.6
 * quantifies over, and `lyricsDocumentDefects` states each one together with the round
 * trip it would otherwise break. Every property below asserts the generator really did
 * land inside that set, so a constraint that silently stopped constraining would fail
 * here rather than quietly shrink the property's scope.
 */

const NUM_RUNS = 200;

/** Latin, Hangul, punctuation and spaces: enough to exercise trimming and Unicode. */
const LYRIC_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...' \t',
  ...'가나다라마바사',
  ...".,!?'\"()-—…",
];

const arbChar = fc.constantFrom(...LYRIC_CHARS);

/**
 * A plain lyric line: at least one non-space character, and not a whole bracket tag.
 *
 * The filter rejects only all-whitespace runs, so it does not distort the
 * distribution; a tag-shaped result is impossible because `[` and `]` are not in the
 * character set.
 */
const arbPlainLyricLine = fc
  .array(arbChar, { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(''))
  .filter((line) => !isEmptyLyricLine(line));

/**
 * A lyric line that *starts* with something bracket-shaped, e.g. `[Verse] oh oh`.
 *
 * This is the case the tag rule is narrow for: such a line is content, not a header,
 * and if the parser widened its rule these would silently become empty sections.
 */
const arbBracketishLyricLine = fc
  .tuple(
    fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS, 'hook', 'x'),
    fc.array(arbChar, { minLength: 1, maxLength: 12 }).map((chars) => chars.join('')),
  )
  .map(([label, suffix]) => `[${label}]${suffix}`)
  .filter((line) => !isTagLine(line) && !isEmptyLyricLine(line));

const arbLyricLine = fc.oneof(
  { weight: 4, arbitrary: arbPlainLyricLine },
  { weight: 1, arbitrary: arbBracketishLyricLine },
);

/** A custom label that reprints as itself: no brackets, trim-stable, not recognised. */
const arbCustomLabel = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789-'), {
    minLength: 1,
    maxLength: 14,
  })
  .map((chars) => chars.join(''))
  .filter((label) => {
    const reclassified = classifyTagLabel(label);
    return reclassified.kind === 'custom' && reclassified.label === label;
  });

const arbTaggedSectionType: fc.Arbitrary<LyricsSectionType> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS).map(
      (name): LyricsSectionType => ({ kind: 'recognised', name }),
    ) },
  { weight: 2, arbitrary: fc
      .tuple(fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS), fc.nat({ max: 12 }))
      .map(([name, ordinal]): LyricsSectionType => ({ kind: 'recognised', name, ordinal })) },
  { weight: 1, arbitrary: arbCustomLabel.map(
      (label): LyricsSectionType => ({ kind: 'custom', label }),
    ) },
);

const arbTaggedSection: fc.Arbitrary<LyricsSection> = fc.record({
  type: arbTaggedSectionType,
  // An empty tagged section is legitimate: `[Verse]` immediately followed by
  // `[Chorus]` is a real thing in a sheet, and it round-trips.
  lines: fc.array(arbLyricLine, { maxLength: 6 }),
});

/**
 * A valid `Lyrics_Document`.
 *
 * The Requirement 9.3 leading section, when present, sits at index 0 and is non-empty
 * — the two conditions that make it survive printing, which erases it to bare lines.
 */
const arbLyricsDocument: fc.Arbitrary<LyricsDocument> = fc
  .tuple(
    fc.option(fc.array(arbLyricLine, { minLength: 1, maxLength: 4 }), { nil: undefined }),
    fc.array(arbTaggedSection, { maxLength: 7 }),
  )
  .map(([leadingLines, sections]) => ({
    sections: [
      ...(leadingLines === undefined ? [] : [{ type: LEADING_SECTION, lines: leadingLines }]),
      ...sections,
    ],
  }));

/** Any tag line, including unrecognised ones and the degenerate `[]`. */
const arbTagLine = fc
  .oneof(
    fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS).map((name) => name),
    fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS).map((name) => name.toLowerCase()),
    fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS).map((name) => name.toUpperCase()),
    fc
      .tuple(fc.constantFrom(...RECOGNISED_LYRICS_SECTIONS), fc.nat({ max: 9 }))
      .map(([name, ordinal]) => `${name} ${String(ordinal)}`),
    fc.constantFrom('Pre Chorus', 'prechorus', 'Hook', 'Refrain', 'Rap', '', 'Verse 01', '  Chorus  '),
    arbCustomLabel,
  )
  .map((label) => `[${label}]`);

/** Blank in every way the parser must treat as blank. */
const arbBlankLine = fc.constantFrom('', ' ', '   ', '\t', ' \t ');

const arbRawLine = fc.oneof(
  { weight: 5, arbitrary: arbLyricLine },
  { weight: 3, arbitrary: arbTagLine },
  { weight: 2, arbitrary: arbBlankLine },
);

/**
 * Arbitrary tagged plain text, joined with one of the three line terminators.
 *
 * The terminator is varied because a lyric sheet pasted from Windows must produce the
 * same document as the same sheet from Unix; a `\r` retained on every line would make
 * both the idempotence and the line count depend on the user's editor.
 */
const arbLyricsText = fc
  .tuple(
    fc.array(arbRawLine, { maxLength: 24 }),
    fc.constantFrom('\n', '\r\n', '\r'),
  )
  .map(([lines, terminator]) => lines.join(terminator));

function expectEquivalent(left: LyricsDocument, right: LyricsDocument): void {
  const verdict = lyricsDocumentsEquivalent(left, right);
  if (!verdict.equivalent) throw new Error(`documents differ: ${verdict.reason}`);
}

describe('Feature: ai-music-generation-service, Property 1: 유효한 Lyrics_Document를 Lyrics_Printer로 출력한 후 Lyrics_Parser로 재파싱한 결과는 원본 Lyrics_Document와 동등하다', () => {
  /**
   * **Validates: Requirements 9.6**
   */
  it('print then parse returns an equivalent document, for every valid document', () => {
    fc.assert(
      fc.property(arbLyricsDocument, (document) => {
        // The generator's own contract. Were it to drift, the property below would
        // still pass while quantifying over a smaller set than Requirement 9.6 does.
        expect(lyricsDocumentDefects(document)).toEqual([]);

        expectEquivalent(document, parseLyrics(printLyrics(document)).document);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Feature: ai-music-generation-service, Property 2: 파싱에 성공한 가사 평문에 대해 파싱→출력→재파싱 결과는 첫 파싱 결과와 동등하다', () => {
  /**
   * **Validates: Requirements 9.7**
   */
  it('parse, print and parse again agrees with the first parse, for any plain text', () => {
    fc.assert(
      fc.property(arbLyricsText, (text) => {
        const first = parseLyrics(text).document;

        // Why Property 2 follows from Property 1 rather than being independent: the
        // parser always lands inside the set Property 1 quantifies over.
        expect(isValidLyricsDocument(first)).toBe(true);

        expectEquivalent(first, parseLyrics(printLyrics(first)).document);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('reaches a textual fixed point after the first print', () => {
    // Not required by Requirement 9.7, which is stated over documents — but a printer
    // whose output was not stable would make diffing two saved lyric sheets noisy.
    fc.assert(
      fc.property(arbLyricsText, (text) => {
        const once = printLyrics(parseLyrics(text).document);
        expect(printLyrics(parseLyrics(once).document)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Feature: ai-music-generation-service, Property 3: 파싱 결과의 전체 가사 행 개수는 입력 평문의 비어있지 않은 비태그 행 개수와 동일하다', () => {
  /**
   * **Validates: Requirements 9.8**
   */
  it('keeps every non-empty non-tag line and invents none, for any plain text', () => {
    fc.assert(
      fc.property(arbLyricsText, (text) => {
        expect(lyricsLineCount(parseLyrics(text).document)).toBe(countPlainTextLyricLines(text));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('survives printing: the invariant holds again on the printed text', () => {
    // The composition is where a leak would show — a line dropped by the printer and
    // a line invented by the parser would cancel out in a single-pass count.
    fc.assert(
      fc.property(arbLyricsText, (text) => {
        const expected = countPlainTextLyricLines(text);
        const printed = printLyrics(parseLyrics(text).document);
        expect(countPlainTextLyricLines(printed)).toBe(expected);
        expect(lyricsLineCount(parseLyrics(printed).document)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
