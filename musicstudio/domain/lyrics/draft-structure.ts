/**
 * Requirement 8.4: a generated lyric draft carries at least one Verse and at least
 * one Chorus.
 *
 * A pure predicate over a parsed `Lyrics_Document`, kept in `domain/` rather than in
 * Lyrics_Assistant because it is a statement about lyric structure, not about the
 * engine call that produced it. That placement is what lets the criterion be tested
 * without a transport, and lets the assistant enforce it by *reading the draft it
 * received* rather than by trusting the engine's prose.
 *
 * A section counts only when it is a recognised Verse or Chorus. `[Versee]` and
 * `[Hook]` are preserved as custom sections (Requirement 9.4) and do not satisfy the
 * criterion — accepting a near-miss label would make the guarantee unfalsifiable.
 * An ordinal is irrelevant: `[Verse 2]` is a Verse.
 */

import type { LyricsDocument } from './document';
import { isRecognisedSection, type RecognisedLyricsSection } from './section-type';

/** The sections Requirement 8.4 requires a draft to contain. */
export const REQUIRED_DRAFT_SECTIONS: readonly RecognisedLyricsSection[] = ['Verse', 'Chorus'];

/** The required sections `document` is missing, in the order they are required. */
export function missingDraftSections(
  document: LyricsDocument,
): readonly RecognisedLyricsSection[] {
  return REQUIRED_DRAFT_SECTIONS.filter(
    (name) => !document.sections.some((section) => isRecognisedSection(section.type, name)),
  );
}

export function satisfiesDraftStructure(document: LyricsDocument): boolean {
  return missingDraftSections(document).length === 0;
}
