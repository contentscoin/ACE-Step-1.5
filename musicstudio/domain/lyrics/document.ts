/**
 * `Lyrics_Document` and its validity predicate (Requirements 9.1, 9.3, 9.8; §7.1).
 *
 * A document is an ordered list of sections, each a section type plus its lyric
 * lines. Order is the whole point of Requirement 9.1, so it is carried by the array
 * and never by a sort key that a caller could reorder.
 *
 * `isValidLyricsDocument` is not defensive plumbing — it is the definition of the
 * word "유효한" in Requirement 9.6, and every condition in it is there because a
 * document violating that condition provably does *not* survive a print-then-parse
 * round trip. Each condition below names the round trip it would break. Making
 * validity explicit rather than assumed is what lets Property 1 state a total
 * guarantee instead of a hopeful one, and `parseLyrics` is required (and asserted)
 * to return only valid documents, which is why Property 2 follows from Property 1.
 */

import { classifyTagLabel, isEmptyLyricLine, isTagLine } from './section-type';
import type { LyricsSectionType } from './section-type';

export interface LyricsSection {
  readonly type: LyricsSectionType;
  /** Lyric lines in order, each free of line terminators. May be empty. */
  readonly lines: readonly string[];
}

export interface LyricsDocument {
  readonly sections: readonly LyricsSection[];
}

export const EMPTY_LYRICS_DOCUMENT: LyricsDocument = { sections: [] };

/** Total number of lyric lines across every section — Requirement 9.8's left side. */
export function lyricsLineCount(document: LyricsDocument): number {
  return document.sections.reduce((total, section) => total + section.lines.length, 0);
}

/**
 * Requirement 9.8's right side: non-empty, non-tag lines of a plain-text input.
 *
 * "Empty" and "tag line" are decided by `isEmptyLyricLine` and `isTagLine`, so this
 * count and the parser's own classification are the same rule read twice rather
 * than two rules that happen to agree today.
 */
export function countPlainTextLyricLines(text: string): number {
  return splitLyricsLines(text).filter(isLyricLine).length;
}

/** True for a line the parser will keep as lyric content. */
export function isLyricLine(rawLine: string): boolean {
  return !isEmptyLyricLine(rawLine) && !isTagLine(rawLine);
}

/**
 * Splits on any line terminator.
 *
 * `\r\n` and a bare `\r` are both accepted so that a lyric sheet pasted from a
 * Windows editor produces the same document as the same sheet from a Unix one —
 * otherwise every line would end with a stray `\r` and the round trip would depend
 * on the user's operating system.
 */
export function splitLyricsLines(text: string): readonly string[] {
  return text.split(/\r\n|\r|\n/u);
}

export type LyricsDocumentDefect =
  | { readonly kind: 'leading_section_out_of_position'; readonly sectionIndex: number }
  | { readonly kind: 'empty_leading_section' }
  | { readonly kind: 'unprintable_custom_label'; readonly sectionIndex: number; readonly label: string }
  | { readonly kind: 'invalid_ordinal'; readonly sectionIndex: number; readonly ordinal: number }
  | {
      readonly kind: 'unprintable_line';
      readonly sectionIndex: number;
      readonly lineIndex: number;
      readonly line: string;
    };

/**
 * Every reason `document` would not survive print-then-parse, or an empty list.
 *
 * Returned as a list rather than a boolean so the generator in the property suite
 * can be checked against the *reason* it produced an invalid document, and so a
 * failure is diagnosable without stepping through the printer.
 */
export function lyricsDocumentDefects(
  document: LyricsDocument,
): readonly LyricsDocumentDefect[] {
  const defects: LyricsDocumentDefect[] = [];

  document.sections.forEach((section, sectionIndex) => {
    const { type } = section;

    if (type.kind === 'leading') {
      // The leading section is defined by having no tag, so nothing marks where it
      // starts. Anywhere but first, its lines would be read as belonging to the
      // preceding tagged section.
      if (sectionIndex !== 0) defects.push({ kind: 'leading_section_out_of_position', sectionIndex });
      // With no tag and no lines it prints as nothing at all, so the next parse
      // cannot know it was ever there.
      if (section.lines.length === 0) defects.push({ kind: 'empty_leading_section' });
    }

    if (type.kind === 'custom') {
      const reclassified = classifyTagLabel(type.label);
      const printable =
        !/[[\]\r\n]/u.test(type.label) &&
        reclassified.kind === 'custom' &&
        reclassified.label === type.label;
      // A label containing a bracket prints a line that is no longer a tag line; a
      // label that reclassifies as recognised (`[verse]`) comes back as a different
      // section kind; a label needing a trim comes back as its trimmed self.
      if (!printable) {
        defects.push({ kind: 'unprintable_custom_label', sectionIndex, label: type.label });
      }
    }

    if (type.kind === 'recognised' && type.ordinal !== undefined) {
      // `2.5` or `-1` or `1e21` do not reprint as the digits they came from.
      if (!Number.isSafeInteger(type.ordinal) || type.ordinal < 0) {
        defects.push({ kind: 'invalid_ordinal', sectionIndex, ordinal: type.ordinal });
      }
    }

    section.lines.forEach((line, lineIndex) => {
      // An empty line is dropped by the next parse; a tag-shaped line becomes a
      // section header; an embedded terminator splits into two lines.
      if (!isLyricLine(line) || /[\r\n]/u.test(line)) {
        defects.push({ kind: 'unprintable_line', sectionIndex, lineIndex, line });
      }
    });
  });

  return defects;
}

export function isValidLyricsDocument(document: LyricsDocument): boolean {
  return lyricsDocumentDefects(document).length === 0;
}
