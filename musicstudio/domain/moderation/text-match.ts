/**
 * Deterministic phrase matching, shared by every rule in `domain/moderation/`.
 *
 * Substitution (Requirement 16.3), impersonation detection (16.11) and term-based
 * classification (16.1, 16.10) all need the same thing: find a phrase in a body of
 * user text, case-insensitively, without matching inside an unrelated word. Doing
 * it once here is what makes the three rules agree on what "contains" means.
 *
 * Two decisions worth stating, because both are visible in the results:
 *
 * 1. Matching runs against the *original* text, not a normalised copy. A
 *    normalised copy would need an index map back to the original to perform a
 *    substitution, and that map is the part that goes subtly wrong.
 *
 * 2. The word boundary is enforced only against Latin letters, digits and `_`.
 *    Korean attaches particles directly to a noun — "아이유의 감성" contains the
 *    name followed by a Hangul syllable — so a boundary that rejected any adjacent
 *    letter would miss every Korean occurrence. Latin adjacency is still rejected,
 *    which is what keeps "Adele" out of "Adeleine".
 */

/** A half-open `[start, end)` range of the searched string. */
export interface PhraseMatch {
  readonly start: number;
  readonly end: number;
  /** The text actually matched, preserving the original casing and spacing. */
  readonly matchedText: string;
}

const LATIN_OR_DIGIT = /[A-Za-z0-9_]/;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a phrase into a pattern where every run of whitespace matches any run of
 * whitespace, so "Taylor  Swift" and "Taylor Swift" behave identically.
 */
export function phrasePattern(phrase: string): RegExp {
  const source = phrase
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');
  return new RegExp(source, 'giu');
}

function boundaryHolds(text: string, start: number, end: number): boolean {
  const firstChar = text[start];
  const lastChar = text[end - 1];
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;

  // Only an adjacent Latin/digit character on a Latin/digit edge splits a word.
  const leadingClash =
    before !== undefined &&
    firstChar !== undefined &&
    LATIN_OR_DIGIT.test(before) &&
    LATIN_OR_DIGIT.test(firstChar);
  const trailingClash =
    after !== undefined &&
    lastChar !== undefined &&
    LATIN_OR_DIGIT.test(after) &&
    LATIN_OR_DIGIT.test(lastChar);

  return !leadingClash && !trailingClash;
}

/**
 * Every non-overlapping occurrence of `phrase` in `text`, in ascending position.
 *
 * An empty or whitespace-only phrase matches nothing: a rule table entry with a
 * blank term must not flag every input.
 */
export function findPhraseMatches(text: string, phrase: string): PhraseMatch[] {
  if (phrase.trim().length === 0) return [];

  const pattern = phrasePattern(phrase);
  const matches: PhraseMatch[] = [];

  for (const found of text.matchAll(pattern)) {
    const start = found.index;
    const matchedText = found[0];
    if (start === undefined || matchedText.length === 0) continue;

    const end = start + matchedText.length;
    if (boundaryHolds(text, start, end)) {
      matches.push({ start, end, matchedText });
    }
  }

  return matches;
}

export function containsPhrase(text: string, phrase: string): boolean {
  return findPhraseMatches(text, phrase).length > 0;
}
