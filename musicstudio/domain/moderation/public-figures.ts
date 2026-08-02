/**
 * Curated real-person name table — **data, not logic**.
 *
 * Two rules read this table and neither one lives here:
 *
 * - Requirement 16.3 substitutes a real artist's name with a style description.
 *   Only entries that carry a `styleDescription` are substitutable, because a name
 *   with no agreed style wording has nothing to be replaced *by*.
 * - Requirement 16.11 blocks a dialogue script that speaks as a real person. That
 *   rule reads every entry, `styleDescription` or not.
 *
 * The table is deliberately a plain array so it can be reviewed as a list and
 * swapped for a configuration-loaded list without touching a rule: every function
 * in `artist-substitution.ts` and `impersonation.ts` takes the table as an
 * argument and merely defaults to this one. The shipped seed list is small on
 * purpose; a production deployment supplies the maintained list.
 *
 * `styleDescription` must not itself contain a curated name, or substitution would
 * stop being idempotent. `test/unit/moderation/public-figures.test.ts` checks that.
 */

export interface PublicFigureEntry {
  /** The name the table is keyed by, used in audit and notice payloads. */
  readonly canonicalName: string;
  /** Alternative spellings and transliterations, matched the same way. */
  readonly aliases: readonly string[];
  /**
   * Neutral wording describing the sound the name is usually a shorthand for.
   * Present only for musical artists; absent entries are impersonation-only.
   */
  readonly styleDescription?: string;
}

export const CURATED_PUBLIC_FIGURES: readonly PublicFigureEntry[] = [
  {
    canonicalName: 'Taylor Swift',
    aliases: ['테일러 스위프트'],
    styleDescription: 'confessional pop songwriting with bright acoustic-layered production',
  },
  {
    canonicalName: 'Adele',
    aliases: ['아델'],
    styleDescription: 'soul-inflected piano ballad with a powerful contralto lead',
  },
  {
    canonicalName: 'Billie Eilish',
    aliases: ['빌리 아일리시'],
    styleDescription: 'whispered close-mic vocal over sparse bass-forward electronic production',
  },
  {
    canonicalName: 'Drake',
    aliases: ['드레이크'],
    styleDescription: 'melodic hip-hop with half-sung delivery over muted late-night drums',
  },
  {
    canonicalName: 'IU',
    aliases: ['아이유', 'Lee Ji-eun'],
    styleDescription: 'clear-toned Korean pop vocal with warm mid-tempo acoustic arrangement',
  },
  {
    canonicalName: 'BTS',
    aliases: ['방탄소년단'],
    styleDescription: 'high-energy Korean pop with layered group vocals and rap verses',
  },
  {
    canonicalName: 'Freddie Mercury',
    aliases: ['프레디 머큐리'],
    styleDescription: 'theatrical rock vocal with multi-tracked harmony choruses',
  },
  {
    canonicalName: 'Ariana Grande',
    aliases: ['아리아나 그란데'],
    styleDescription: 'airy upper-register pop vocal with tight R&B-leaning harmony stacks',
  },
];

/** Entries Requirement 16.3 can substitute — those with agreed style wording. */
export function substitutableFigures(
  table: readonly PublicFigureEntry[] = CURATED_PUBLIC_FIGURES,
): readonly PublicFigureEntry[] {
  return table.filter((entry) => entry.styleDescription !== undefined);
}

/** Canonical name plus every alias, in table order then alias order. */
export function figureNames(entry: PublicFigureEntry): readonly string[] {
  return [entry.canonicalName, ...entry.aliases];
}
