/**
 * Paralinguistic tags in a script (Requirements 25.8, 25.9).
 *
 * 25.8: where the engine supports them, `[laugh]`, `[sigh]` and `[gasp]` are synthesised as
 * utterances "스크립트 내 위치에 대응하는" — at the position they occupy in the script.
 * 25.9: where the engine does not, they are removed from the synthesis input and the removed
 * tag *names* are returned in the response.
 *
 * ### Position is preserved by not moving anything
 *
 * 25.8 needs no code beyond leaving the tag where it is: the script handed to a supporting
 * engine is the script the user wrote, tag markers included, and the engine reads them in
 * place. Extracting the tags into a side channel with offsets would be the way to *lose*
 * 25.8 — the offsets would then have to survive 25.11's chunk boundaries, and a tag sitting
 * across a cut would have no well-defined position at all. So the only transformation here is
 * 25.9's removal.
 *
 * ### What removal does to the surrounding text
 *
 * The tag and nothing else is removed. Adjacent spaces are left alone, because collapsing
 * whitespace would change character offsets the caller may already hold — 25.11's chunk
 * offsets are computed on the script this module returns — and because a double space is
 * harmless to a synthesiser while a lost one can join two words.
 *
 * ### Unknown bracketed text is not a tag
 *
 * `[laugh]` is a tag; `[whisper]` is not, because 25.8 enumerates three. An unrecognised
 * bracketed token is left in the script verbatim and never reported as removed: it is
 * ordinary text as far as this requirement is concerned, and silently deleting it would
 * destroy content the user wrote — a stage direction in a screenplay, most obviously.
 */

/** Requirement 25.8's three tags, by name. */
export const PARALINGUISTIC_TAGS = ['laugh', 'sigh', 'gasp'] as const;

export type ParalinguisticTag = (typeof PARALINGUISTIC_TAGS)[number];

export function isParalinguisticTag(value: unknown): value is ParalinguisticTag {
  return typeof value === 'string' && (PARALINGUISTIC_TAGS as readonly string[]).includes(value);
}

/**
 * One tag occurrence, with where it sits.
 *
 * The offset is reported for diagnosis and for 25.8's "위치" being checkable, not because
 * anything downstream repositions the tag. See the module comment.
 */
export interface TagOccurrence {
  readonly tag: ParalinguisticTag;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Matches only the three names of 25.8, case-insensitively, with no inner whitespace. */
const TAG_PATTERN = /\[(laugh|sigh|gasp)\]/giu;

/** Every recognised tag in the script, in order of appearance. */
export function findParalinguisticTags(script: string): readonly TagOccurrence[] {
  const found: TagOccurrence[] = [];
  for (const match of script.matchAll(TAG_PATTERN)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!isParalinguisticTag(name)) continue;
    found.push({
      tag: name,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }
  return found;
}

export interface TagResolution {
  /** What the engine is asked to synthesise. */
  readonly script: string;
  /**
   * Requirement 25.9's 제거된 태그 이름 목록.
   *
   * De-duplicated and in first-appearance order: 25.9 asks for the tag *names*, so three
   * `[laugh]`s are one name, and a client rendering "these tags were dropped" wants the
   * list of things rather than a tally.
   */
  readonly removedTags: readonly ParalinguisticTag[];
  /** Tags left in place because the engine supports them (25.8). */
  readonly retainedTags: readonly ParalinguisticTag[];
}

/**
 * Requirements 25.8 and 25.9 as one step: keep the tags a supporting engine understands,
 * strip the ones it does not, and name what was stripped.
 *
 * `supported` is the engine's own capability flag rather than a per-tag list, because 25.8
 * and 25.9 are both stated as a whole-engine `WHERE`: an engine either supports 준언어 태그
 * or it does not. A future engine supporting `[laugh]` but not `[gasp]` would need the
 * capability widened to a set, and this signature is the one place that would change.
 */
export function resolveParalinguisticTags(script: string, supported: boolean): TagResolution {
  const occurrences = findParalinguisticTags(script);
  const names = dedupe(occurrences.map((occurrence) => occurrence.tag));

  if (supported) {
    return { script, removedTags: [], retainedTags: names };
  }

  // Removed right to left, so each earlier occurrence's offsets are still valid when it is
  // reached. Splicing left to right would shift every remaining offset by the tag's length.
  let stripped = script;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    if (occurrence === undefined) continue;
    stripped =
      stripped.slice(0, occurrence.startOffset) + stripped.slice(occurrence.endOffset);
  }

  return { script: stripped, removedTags: names, retainedTags: [] };
}

function dedupe(tags: readonly ParalinguisticTag[]): readonly ParalinguisticTag[] {
  return [...new Set(tags)];
}
