/**
 * Requirement 16.3 — replace a real artist's name used as a style specification
 * with a style description, and report that the replacement happened.
 *
 * The rule is a pure function of (text, table), so the same input always yields the
 * same output text and the same notices. Three tie-breaks make that true even when
 * candidate names overlap:
 *
 * 1. **Longest name first.** "Taylor Swift" wins over a hypothetical "Taylor", so a
 *    shorter entry never eats the prefix of a longer one.
 * 2. **Leftmost match first**, then longest, then table order. Accepted matches
 *    never overlap; a candidate starting inside an accepted range is dropped.
 * 3. **Single pass.** The replacement text is not re-scanned, so a style
 *    description that happened to contain a curated name could not cascade. The
 *    table forbids that anyway (`public-figures.ts`), and this keeps the guarantee
 *    independent of the table's contents.
 *
 * Substitution is not a block: Requirement 16.3 rewrites and notifies, and the
 * request proceeds with the rewritten text.
 */

import {
  CURATED_PUBLIC_FIGURES,
  figureNames,
  substitutableFigures,
  type PublicFigureEntry,
} from './public-figures';
import { findPhraseMatches } from './text-match';

/** What the user is told: which name was replaced, and by what. */
export interface ArtistSubstitution {
  /** Exactly the characters removed from the input, original casing preserved. */
  readonly matchedText: string;
  readonly canonicalName: string;
  readonly styleDescription: string;
  /** Offset in the *original* text, so a caller can highlight the change. */
  readonly startIndex: number;
}

export interface ArtistSubstitutionResult {
  /** The text to send onward. Identical to the input when nothing matched. */
  readonly text: string;
  /** Ascending by `startIndex`. Empty means no artist name was present. */
  readonly substitutions: readonly ArtistSubstitution[];
}

interface Candidate {
  readonly entry: PublicFigureEntry;
  readonly name: string;
  readonly tableRank: number;
}

interface AcceptedMatch extends ArtistSubstitution {
  readonly endIndex: number;
}

function candidatesOf(table: readonly PublicFigureEntry[]): Candidate[] {
  const candidates: Candidate[] = [];
  substitutableFigures(table).forEach((entry, tableRank) => {
    for (const name of figureNames(entry)) {
      candidates.push({ entry, name, tableRank });
    }
  });

  // Longest name first so a longer entry claims the span before a shorter one;
  // remaining ties resolved by table order then name, never by iteration accident.
  return candidates.sort(
    (left, right) =>
      right.name.length - left.name.length ||
      left.tableRank - right.tableRank ||
      left.name.localeCompare(right.name, 'en'),
  );
}

export function substituteArtistNames(
  text: string,
  table: readonly PublicFigureEntry[] = CURATED_PUBLIC_FIGURES,
): ArtistSubstitutionResult {
  const found: (AcceptedMatch & { readonly rank: number })[] = [];

  candidatesOf(table).forEach((candidate, rank) => {
    const styleDescription = candidate.entry.styleDescription;
    if (styleDescription === undefined) return;

    for (const match of findPhraseMatches(text, candidate.name)) {
      found.push({
        matchedText: match.matchedText,
        canonicalName: candidate.entry.canonicalName,
        styleDescription,
        startIndex: match.start,
        endIndex: match.end,
        rank,
      });
    }
  });

  if (found.length === 0) return { text, substitutions: [] };

  found.sort(
    (left, right) =>
      left.startIndex - right.startIndex ||
      right.endIndex - left.endIndex ||
      left.rank - right.rank,
  );

  const accepted: AcceptedMatch[] = [];
  let consumedTo = 0;
  for (const match of found) {
    if (match.startIndex < consumedTo) continue;
    accepted.push(match);
    consumedTo = match.endIndex;
  }

  let rewritten = '';
  let cursor = 0;
  for (const match of accepted) {
    rewritten += text.slice(cursor, match.startIndex) + match.styleDescription;
    cursor = match.endIndex;
  }
  rewritten += text.slice(cursor);

  return {
    text: rewritten,
    substitutions: accepted.map(({ matchedText, canonicalName, styleDescription, startIndex }) => ({
      matchedText,
      canonicalName,
      styleDescription,
      startIndex,
    })),
  };
}
