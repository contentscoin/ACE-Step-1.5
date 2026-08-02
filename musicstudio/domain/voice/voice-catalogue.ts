/**
 * The predefined voice catalogue (Requirements 26.9, 26.10).
 *
 * 26.9: "사전 정의 음성 카탈로그를 제공하고 각 항목에 엔진 식별자, 음성 식별자, 언어 코드를
 * 표시한다". Three fields per entry, exactly, and they are the three a `preset` Voice_Profile is
 * built from — which is why 26.10's engine binding needs no separate lookup: the entry *is* the
 * binding.
 *
 * ### Why the catalogue is data rather than a port
 *
 * A preset voice's identifier is only meaningful to one engine, so the catalogue is a property
 * of the registered engines rather than of a user or a deployment. Modelling it as a value
 * keeps 26.10 checkable without a store, and the seed below is the initial content — a
 * deployment that adds engines supplies its own entries, the same way
 * `adapters/registry/default-engines.ts` seeds the assignment table.
 *
 * The seeded entries name `tts-engine-a` and `tts-engine-b`, the two identifiers design §3.6
 * already fixes for `dialogue`, and their language codes are the ones
 * `adapters/tts/capabilities.ts` declares. **The specific voice identifiers and display names
 * are a product decision**, not a transcription: no requirement names any particular preset
 * voice, and Requirement 26.9 asks only that each entry carry the three fields.
 */

import { isLanguageCode, normaliseLanguageCode } from '../speech/language';

export interface PresetVoiceEntry {
  /** Requirement 26.9 — 음성 식별자. Unique within the catalogue, not merely within an engine. */
  readonly voiceId: string;
  /** Requirement 26.9 — 엔진 식별자, and 26.10's binding. */
  readonly engineId: string;
  /** Requirement 26.9 — 언어 코드, ISO 639-1. */
  readonly languageCode: string;
  /** What a picker shows. Not required by 26.9; a bare identifier is not a choosable voice. */
  readonly displayName: string;
}

/**
 * Requirement 26.9's initial catalogue.
 *
 * Deliberately small and deliberately spanning both engines: 26.9's presentation obligation and
 * 26.11's refusal are only testable when at least two engines appear, and a catalogue that
 * covered one engine would let a `preset` profile's binding look like a no-op.
 */
export const DEFAULT_PRESET_VOICE_CATALOGUE: readonly PresetVoiceEntry[] = [
  { voiceId: 'a-ko-narrator', engineId: 'tts-engine-a', languageCode: 'ko', displayName: '한국어 내레이터' },
  { voiceId: 'a-en-narrator', engineId: 'tts-engine-a', languageCode: 'en', displayName: 'English Narrator' },
  { voiceId: 'a-ja-narrator', engineId: 'tts-engine-a', languageCode: 'ja', displayName: '日本語ナレーター' },
  { voiceId: 'b-en-announcer', engineId: 'tts-engine-b', languageCode: 'en', displayName: 'English Announcer' },
  { voiceId: 'b-es-announcer', engineId: 'tts-engine-b', languageCode: 'es', displayName: 'Locutor en español' },
  { voiceId: 'b-ko-announcer', engineId: 'tts-engine-b', languageCode: 'ko', displayName: '한국어 아나운서' },
];

export function findPresetVoice(
  catalogue: readonly PresetVoiceEntry[],
  voiceId: string,
): PresetVoiceEntry | undefined {
  return catalogue.find((entry) => entry.voiceId === voiceId);
}

/** Requirement 26.9's listing, optionally narrowed to one engine or one language. */
export interface CatalogueQuery {
  readonly engineId?: string;
  readonly languageCode?: string;
}

export function listPresetVoices(
  catalogue: readonly PresetVoiceEntry[],
  query: CatalogueQuery = {},
): readonly PresetVoiceEntry[] {
  const language =
    query.languageCode === undefined ? undefined : normaliseLanguageCode(query.languageCode);
  return catalogue.filter(
    (entry) =>
      (query.engineId === undefined || entry.engineId === query.engineId) &&
      (language === undefined || entry.languageCode === language),
  );
}

/**
 * Requirement 26.9's three fields, present and well formed on every entry.
 *
 * A predicate rather than a validator because the catalogue is seeded data: a malformed entry is
 * a programming error, and the unit test asserting this is what catches it. Uniqueness of
 * `voiceId` is included because 26.10 resolves an engine *from* the identifier, and a duplicate
 * would make that resolution ambiguous.
 */
export function isWellFormedCatalogue(catalogue: readonly PresetVoiceEntry[]): boolean {
  const ids = new Set(catalogue.map((entry) => entry.voiceId));
  if (ids.size !== catalogue.length) return false;

  return catalogue.every(
    (entry) =>
      entry.voiceId.length > 0 &&
      entry.engineId.length > 0 &&
      entry.displayName.length > 0 &&
      isLanguageCode(entry.languageCode),
  );
}
