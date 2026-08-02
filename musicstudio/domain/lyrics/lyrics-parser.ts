/**
 * `Lyrics_Parser` (Requirements 9.1–9.4; design §7.3).
 *
 * Pure and total: text in, `Lyrics_Document` out, always. It returns no
 * `ParseResult` because Requirement 9 defines no rejection — 9.4 makes the only
 * irregular input, an unrecognised `[Tag]`, a *preserved* custom section plus a
 * warning, and every other line is either lyric content, a recognised tag, or
 * blank. Wrapping a total function in a failure union would force every caller
 * through a branch that cannot be taken.
 *
 * The parser guarantees more than the requirements state, and the extra guarantee
 * is what the property suite leans on: **every document it returns is valid** in the
 * sense of `isValidLyricsDocument`. That is why Requirement 9.7's idempotence
 * follows from Requirement 9.6's round trip rather than needing a separate
 * argument — parsing lands inside the set on which the round trip is guaranteed.
 * `test/property/lyrics-round-trip.test.ts` asserts it directly rather than
 * trusting the reasoning.
 */

import type { ParseWarning } from '../parse-error';

import {
  isEmptyLyricLine,
  classifyTagLabel,
  tagLabelOf,
  LEADING_SECTION,
  type LyricsSectionType,
} from './section-type';
import { splitLyricsLines, type LyricsDocument, type LyricsSection } from './document';

export interface LyricsParseOutcome {
  readonly document: LyricsDocument;
  /** Requirement 9.4's warnings, one per unrecognised tag, with its line number. */
  readonly warnings: readonly ParseWarning[];
}

/** Requirement 9.4's warning code, exported so callers can branch without matching prose. */
export const UNRECOGNISED_SECTION_TAG = 'unrecognised_section_tag';

export function parseLyrics(text: string): LyricsParseOutcome {
  const sections: LyricsSection[] = [];
  const warnings: ParseWarning[] = [];

  // The section being filled. `null` until either a tag appears or a lyric line
  // forces the Requirement 9.3 leading section into existence.
  let openType: LyricsSectionType | null = null;
  let openLines: string[] = [];

  const closeOpenSection = (): void => {
    if (openType === null) return;
    sections.push({ type: openType, lines: openLines });
  };

  splitLyricsLines(text).forEach((rawLine, index) => {
    const label = tagLabelOf(rawLine);

    if (label !== null) {
      // Requirement 9.1: a tag closes the previous section and opens the next, so
      // document order follows text order with nothing reordered or merged.
      closeOpenSection();
      const type = classifyTagLabel(label);
      if (type.kind === 'custom') {
        // Requirement 9.4: preserved, *and* reported.
        warnings.push({
          line: index + 1,
          code: UNRECOGNISED_SECTION_TAG,
          message: `Unrecognised section tag "${type.label}" preserved as a custom section.`,
          actual: rawLine.trim(),
        });
      }
      openType = type;
      openLines = [];
      return;
    }

    // A blank line carries no lyric (design §7.3's invariant counts only non-empty
    // non-tag lines), so it neither becomes content nor opens a section.
    if (isEmptyLyricLine(rawLine)) return;

    // Requirement 9.3: content before any tag belongs to a section with no kind.
    if (openType === null) openType = LEADING_SECTION;
    openLines.push(rawLine);
  });

  closeOpenSection();

  return { document: { sections }, warnings };
}
