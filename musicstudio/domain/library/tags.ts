/**
 * Requirement 11.3's 태그: normalisation, validation, and the search they participate in.
 *
 * Tags are normalised **before** they are stored — lower-cased and trimmed — so that the
 * store holds one spelling of a tag and Requirement 11.3's search does not have to
 * case-fold at read time. `asset_tag_normalised` in `0016_library.sql` refuses anything
 * else, which makes the normalisation a property of the data rather than of whichever
 * code path happened to write it.
 */

import {
  ASSET_TAG_COUNT_MAX,
  ASSET_TAG_MAX_LENGTH,
  ASSET_TAG_MIN_LENGTH,
} from './bounds';

export type TagViolationCode =
  | 'tag_empty'
  | 'tag_too_long'
  | 'tag_count_exceeded'
  | 'tag_not_a_string';

export interface TagViolation {
  readonly violation: TagViolationCode;
  /** The offending tag, as supplied. Absent for `tag_count_exceeded`, which is about the set. */
  readonly tag?: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** Lower-case and collapse surrounding whitespace. Inner spacing is the user's. */
export function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Normalise, drop duplicates, keep first-seen order.
 *
 * De-duplication happens here rather than at the store because two spellings of one tag
 * (`Lo-Fi`, `lo-fi`) become the same tag only after normalisation, and a caller that
 * submitted both should see one tag accepted rather than a primary-key error.
 */
export function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = normaliseTag(raw);
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/**
 * Validate a whole tag set, reporting every violation rather than the first.
 *
 * The set is judged *after* normalisation, so `['A', 'a']` is one tag and not two, and the
 * count ceiling counts what would actually be stored.
 */
export function tagViolations(tags: readonly unknown[]): TagViolation[] {
  const violations: TagViolation[] = [];

  for (const raw of tags) {
    if (typeof raw !== 'string') {
      violations.push({ violation: 'tag_not_a_string', actual: String(raw) });
      continue;
    }
    const tag = normaliseTag(raw);
    if (tag.length < ASSET_TAG_MIN_LENGTH) {
      violations.push({ violation: 'tag_empty', tag: raw });
      continue;
    }
    if (tag.length > ASSET_TAG_MAX_LENGTH) {
      violations.push({
        violation: 'tag_too_long',
        tag: raw,
        expected: `${String(ASSET_TAG_MIN_LENGTH)}..${String(ASSET_TAG_MAX_LENGTH)}`,
        actual: String(tag.length),
      });
    }
  }

  const distinct = normaliseTags(tags.filter((tag): tag is string => typeof tag === 'string'));
  if (distinct.length > ASSET_TAG_COUNT_MAX) {
    violations.push({
      violation: 'tag_count_exceeded',
      expected: `<= ${String(ASSET_TAG_COUNT_MAX)}`,
      actual: String(distinct.length),
    });
  }

  return violations;
}

export function isValidTagSet(tags: readonly unknown[]): boolean {
  return tagViolations(tags).length === 0;
}
