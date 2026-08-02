/**
 * Language codes and per-engine language support (Requirements 25.2, 25.3).
 *
 * 25.2 requires two or more synthesis engines *and* each engine's supported language list to
 * be presented alongside it. 25.3 refuses a request whose language the chosen engine does not
 * support and answers with "해당 언어를 지원하는 엔진 식별자 목록" — the engines that *do*.
 *
 * Those two criteria only work together if the language lists live somewhere the refusal can
 * read them, which is why this is a domain type rather than a field buried in an adapter: the
 * refusal has to name engines other than the one that was asked, so it needs the catalogue,
 * not one engine's opinion. `adapters/tts/capabilities.ts` supplies the entries; nothing here
 * knows which engines exist.
 *
 * ### Why the code is validated as ISO 639-1 and not against a closed list
 *
 * Requirement 27.3 names ISO 639-1 explicitly and Requirement 25.3 speaks of a "언어 코드"
 * without naming a standard, so both are read as the same two-letter form. The *shape* is
 * checked here — two lowercase ASCII letters — but membership of the 184-entry ISO list is
 * not, because an engine's own list is the authority that matters: a well-formed code no
 * engine supports is refused by 25.3 anyway, with the same answer, and hard-coding the
 * standard's registry here would mean a new engine could support a language this module
 * refused to spell.
 */

/** ISO 639-1 alpha-2, lowercase. */
export function isLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2}$/u.test(value);
}

/** Normalises the casing callers vary on (`EN`, `en`) without accepting a wrong shape. */
export function normaliseLanguageCode(value: string): string {
  return value.trim().toLowerCase();
}

export interface EngineLanguageSupport {
  readonly engineId: string;
  /** ISO 639-1 codes, lowercase. Requirement 25.2 presents this beside the engine. */
  readonly languageCodes: readonly string[];
}

export function supportsLanguage(entry: EngineLanguageSupport, languageCode: string): boolean {
  return entry.languageCodes.includes(normaliseLanguageCode(languageCode));
}

/**
 * Requirement 25.3's answer: every engine identifier that supports the language.
 *
 * Possibly empty, and that is a meaningful answer rather than an error — a request for a
 * language no engine speaks is refused with an empty list, which tells the caller the
 * language is unavailable rather than that they chose the wrong engine.
 */
export function enginesSupportingLanguage(
  catalogue: readonly EngineLanguageSupport[],
  languageCode: string,
): readonly string[] {
  const code = normaliseLanguageCode(languageCode);
  return catalogue
    .filter((entry) => entry.languageCodes.includes(code))
    .map((entry) => entry.engineId);
}

export function languageSupportOf(
  catalogue: readonly EngineLanguageSupport[],
  engineId: string,
): EngineLanguageSupport | undefined {
  return catalogue.find((entry) => entry.engineId === engineId);
}

/** Requirement 25.2's presentation: every engine with its languages, in catalogue order. */
export function languageCatalogue(
  catalogue: readonly EngineLanguageSupport[],
): readonly EngineLanguageSupport[] {
  return catalogue.map((entry) => ({
    engineId: entry.engineId,
    languageCodes: [...entry.languageCodes].sort((left, right) => left.localeCompare(right, 'en')),
  }));
}
