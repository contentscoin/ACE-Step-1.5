/**
 * Vocal languages ACE-Step accepts (Requirements 3.7, 3.8).
 *
 * Transcribed from `acestep/constants.py`'s `VALID_LANGUAGES`, which holds 51
 * entries: 50 language codes plus the sentinel `'unknown'`. Requirement 3.7's
 * "50 languages" is therefore the code list, and `'unknown'` is kept separate
 * because it does not name a language — the engine's own UI labels it
 * "Instrumental / auto" and uses it to mean "detect or leave unset".
 *
 * Keeping the sentinel out of `VOCAL_LANGUAGE_CODES` is what makes the count
 * assertable, while `isVocalLanguage` still accepts it, so a caller can ask for
 * automatic detection without the request being classed as an unsupported code.
 */

/** The 50 codes of `VALID_LANGUAGES`, sentinel excluded. Requirement 3.7. */
export const VOCAL_LANGUAGE_CODES: readonly string[] = [
  'ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en',
  'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id',
  'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no',
  'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw',
  'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh',
];

/** `'unknown'` in `VALID_LANGUAGES`: let the engine detect or leave it unset. */
export const VOCAL_LANGUAGE_AUTO = 'unknown';

/** Everything the engine accepts in `vocal_language`: the 50 codes plus the sentinel. */
export const ACCEPTED_VOCAL_LANGUAGES: readonly string[] = [
  ...VOCAL_LANGUAGE_CODES,
  VOCAL_LANGUAGE_AUTO,
];

const ACCEPTED_SET: ReadonlySet<string> = new Set(ACCEPTED_VOCAL_LANGUAGES);

export function isVocalLanguage(value: unknown): value is string {
  return typeof value === 'string' && ACCEPTED_SET.has(value);
}
