/**
 * `Lyrics_Printer` (Requirement 9.5).
 *
 * The inverse of `parseLyrics` up to the §7.1 equivalence relation. Two choices
 * make that inverse total:
 *
 * - **The canonical tag spelling is emitted, not the original one.** `[verse]`,
 *   `[VERSE 2]` and `[Pre Chorus]` all reprint as `[Verse]`, `[Verse 2]` and
 *   `[Pre-Chorus]`. The document does not retain the original casing, so this is not
 *   information loss introduced here — §7.1's relation is about section *kind*, and
 *   the canonical form is the kind's one written representation.
 * - **A blank line separates sections.** It is not required by Requirement 9.5, but
 *   it is what a lyric sheet looks like, and it is free: `parseLyrics` discards
 *   blank lines, so it cannot affect any subsequent parse. Consequently the output
 *   is also a fixed point of print-after-parse, which
 *   `test/unit/lyrics/lyrics-printer.test.ts` pins.
 *
 * The leading section (Requirement 9.3) prints with no tag, which is precisely what
 * makes it reparse as a leading section rather than as a custom one.
 */

import { sectionLabelOf } from './section-type';
import type { LyricsDocument, LyricsSection } from './document';

const SECTION_SEPARATOR = '\n\n';

export function printLyrics(document: LyricsDocument): string {
  return document.sections.map(printSection).join(SECTION_SEPARATOR);
}

function printSection(section: LyricsSection): string {
  const label = sectionLabelOf(section.type);
  const header = label === null ? [] : [`[${label}]`];
  return [...header, ...section.lines].join('\n');
}
