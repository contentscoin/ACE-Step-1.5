/**
 * Lyric section vocabulary (Requirements 9.2–9.4; design §7.3).
 *
 * Three kinds of section exist, and each one is a requirement rather than a
 * modelling convenience:
 *
 * - `recognised` — one of the seven names Requirement 9.2 lists.
 * - `custom` — an unrecognised `[Tag]`, preserved verbatim (Requirement 9.4).
 * - `leading` — the lines that appear before any tag (Requirement 9.3). It carries
 *   no label at all, which is exactly what "종류가 지정되지 않은" means; giving it a
 *   synthetic label such as `[Unknown]` would invent text the user never wrote and
 *   would break the round trip, because printing that label would make the next
 *   parse produce a *custom* section instead of a leading one.
 *
 * Recognition is case-insensitive and tolerant of an ordinal (`[Verse 2]`), because
 * both forms are ubiquitous in real lyric sheets, but the *stored* form is
 * canonical. That split is what lets the printer be a total function: whatever
 * spelling came in, one spelling goes out, and that spelling re-parses to the same
 * section — which is the whole content of Requirement 9.6.
 */

/** The seven section names Requirement 9.2 requires the parser to recognise. */
export const RECOGNISED_LYRICS_SECTIONS = [
  'Intro',
  'Verse',
  'Pre-Chorus',
  'Chorus',
  'Bridge',
  'Instrumental',
  'Outro',
] as const;

export type RecognisedLyricsSection = (typeof RECOGNISED_LYRICS_SECTIONS)[number];

export type LyricsSectionType =
  | { readonly kind: 'leading' }
  | {
      readonly kind: 'recognised';
      readonly name: RecognisedLyricsSection;
      /** `[Verse 2]`'s `2`. Absent for a bare `[Verse]`. */
      readonly ordinal?: number;
    }
  | { readonly kind: 'custom'; readonly label: string };

export const LEADING_SECTION: LyricsSectionType = { kind: 'leading' };

/**
 * Canonical name keyed by its comparison form.
 *
 * `Pre-Chorus` is the only name with internal punctuation, and sheets write it as
 * `Pre-Chorus`, `Pre Chorus` and `PreChorus` interchangeably, so the comparison key
 * drops separators entirely and all three collapse onto one entry.
 */
const CANONICAL_BY_KEY: ReadonlyMap<string, RecognisedLyricsSection> = new Map(
  RECOGNISED_LYRICS_SECTIONS.map((name) => [comparisonKey(name), name]),
);

function comparisonKey(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/gu, '');
}

/**
 * A line that is *entirely* one bracket tag, and nothing else.
 *
 * The rule is deliberately narrow: the trimmed line must open with `[`, close with
 * `]`, and contain no further brackets. `[Verse] oh oh` is therefore a lyric line,
 * not a tag — which matters because it is the only reading under which every input
 * line is unambiguously one thing or the other, and Requirement 9.8's line count is
 * only well defined once that classification is total.
 */
const TAG_LINE = /^\[([^[\]]*)\]$/u;

/** The label inside a tag line, or `null` when the line is not a tag line. */
export function tagLabelOf(rawLine: string): string | null {
  const match = TAG_LINE.exec(rawLine.trim());
  if (match === null) return null;
  return (match[1] ?? '').trim();
}

export function isTagLine(rawLine: string): boolean {
  return tagLabelOf(rawLine) !== null;
}

/**
 * A line holding no non-whitespace character.
 *
 * This is the definition of "empty" that Requirement 9.8's count rests on, pinned
 * in one place so the parser, the printer and the invariant check cannot disagree
 * about it. A line of spaces carries no lyric, so it is empty.
 */
export function isEmptyLyricLine(rawLine: string): boolean {
  return rawLine.trim() === '';
}

/** `[Verse 2]` -> ordinal 2; `[Bridge]` -> no ordinal. */
const LABEL_WITH_ORDINAL = /^(.*?)\s*(\d+)$/u;

/**
 * Classifies a tag label as one of the seven names or as a custom section.
 *
 * An ordinal is only honoured when the remainder is a recognised name: `[Verse 2]`
 * is Verse #2, while `[Chant 2]` stays the custom label `Chant 2` rather than
 * becoming a nameless section numbered 2.
 */
export function classifyTagLabel(
  label: string,
): Extract<LyricsSectionType, { kind: 'recognised' | 'custom' }> {
  const trimmed = label.trim();

  const direct = CANONICAL_BY_KEY.get(comparisonKey(trimmed));
  if (direct !== undefined) return { kind: 'recognised', name: direct };

  const match = LABEL_WITH_ORDINAL.exec(trimmed);
  if (match !== null) {
    const name = CANONICAL_BY_KEY.get(comparisonKey(match[1] ?? ''));
    const ordinal = Number(match[2]);
    // A leading zero (`[Verse 01]`) would not survive being reprinted as `2`, so
    // it is left as a custom label rather than silently renumbered.
    if (name !== undefined && Number.isSafeInteger(ordinal) && String(ordinal) === match[2]) {
      return { kind: 'recognised', name, ordinal };
    }
  }

  return { kind: 'custom', label: trimmed };
}

/** The label a section is printed with, or `null` for the leading section. */
export function sectionLabelOf(type: LyricsSectionType): string | null {
  switch (type.kind) {
    case 'leading':
      return null;
    case 'recognised':
      return type.ordinal === undefined ? type.name : `${type.name} ${String(type.ordinal)}`;
    case 'custom':
      return type.label;
  }
}

/** Structural equality of section kind, used by the §7.1 document equivalence. */
export function sectionTypesEqual(left: LyricsSectionType, right: LyricsSectionType): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'recognised' && right.kind === 'recognised') {
    return left.name === right.name && (left.ordinal ?? null) === (right.ordinal ?? null);
  }
  if (left.kind === 'custom' && right.kind === 'custom') {
    return left.label === right.label;
  }
  return true;
}

export function isRecognisedSection(
  type: LyricsSectionType,
  name: RecognisedLyricsSection,
): boolean {
  return type.kind === 'recognised' && type.name === name;
}
