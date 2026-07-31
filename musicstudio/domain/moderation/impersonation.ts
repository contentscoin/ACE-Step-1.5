/**
 * Requirement 16.11 — detect a dialogue script that contains an utterance
 * impersonating a real person.
 *
 * The criterion is narrower than "the script mentions a real person": a script may
 * legitimately talk *about* someone. What it forbids is 사칭하는 발화 — the speaker
 * presenting themselves *as* that person. So detection needs two things together:
 * a curated real-person name, and a self-identification frame around it.
 *
 * The frames are a data table of templates with a `{name}` hole, matched through the
 * same phrase matcher every other rule uses. Adding a language means adding a
 * template, not editing a rule.
 */

import {
  CURATED_PUBLIC_FIGURES,
  figureNames,
  type PublicFigureEntry,
} from './public-figures';
import { containsPhrase, findPhraseMatches } from './text-match';

/** Self-identification frames. `{name}` is the only substitution point. */
export const IMPERSONATION_UTTERANCE_TEMPLATES: readonly string[] = [
  'i am {name}',
  "i'm {name}",
  'this is {name}',
  'you are listening to {name}',
  'speaking as {name}',
  '저는 {name}입니다',
  '저는 {name}이에요',
  '나는 {name}이다',
  '{name}입니다',
  '{name}이야',
];

export interface ImpersonationFinding {
  readonly canonicalName: string;
  /** The instantiated template that matched, for the block payload and audit. */
  readonly matchedUtterance: string;
  readonly startIndex: number;
}

function instantiate(template: string, name: string): string {
  return template.split('{name}').join(name);
}

/**
 * Every impersonating utterance in `script`, ascending by position.
 *
 * Templates overlap on purpose — "저는 {name}입니다" contains "{name}입니다" — so
 * overlapping matches are collapsed to the longest one. Without that, a single
 * utterance would be reported as two violations.
 */
export function findImpersonatingUtterances(
  script: string,
  table: readonly PublicFigureEntry[] = CURATED_PUBLIC_FIGURES,
): ImpersonationFinding[] {
  const found: (ImpersonationFinding & { readonly endIndex: number })[] = [];

  for (const entry of table) {
    for (const name of figureNames(entry)) {
      // Cheap reject: no name, no frame worth testing.
      if (!containsPhrase(script, name)) continue;

      for (const template of IMPERSONATION_UTTERANCE_TEMPLATES) {
        for (const match of findPhraseMatches(script, instantiate(template, name))) {
          found.push({
            canonicalName: entry.canonicalName,
            matchedUtterance: match.matchedText,
            startIndex: match.start,
            endIndex: match.end,
          });
        }
      }
    }
  }

  found.sort(
    (left, right) =>
      left.startIndex - right.startIndex ||
      right.endIndex - left.endIndex ||
      left.canonicalName.localeCompare(right.canonicalName, 'en'),
  );

  const accepted: ImpersonationFinding[] = [];
  let consumedTo = 0;
  for (const finding of found) {
    if (finding.startIndex < consumedTo) continue;
    accepted.push({
      canonicalName: finding.canonicalName,
      matchedUtterance: finding.matchedUtterance,
      startIndex: finding.startIndex,
    });
    consumedTo = finding.endIndex;
  }

  return accepted;
}
