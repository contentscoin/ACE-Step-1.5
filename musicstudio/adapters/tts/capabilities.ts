/**
 * What each TTS engine can do (Requirements 25.2, 25.3, 25.7, 25.8, 25.9).
 *
 * Four criteria are decided by an engine's declared capabilities rather than by a request, and
 * all four need the *same* record — so there is one:
 *
 * | criterion | field |
 * |---|---|
 * | 25.2 — 지원 언어 목록 제시 | `languageCodes` |
 * | 25.3 — 미지원 언어 거부 + 지원 엔진 목록 | `languageCodes`, across all entries |
 * | 25.7 — 연기 지시 전달 (`WHERE` the engine supports it) | `supportsActingInstruction` |
 * | 25.8/25.9 — 준언어 태그 합성 또는 제거 | `supportsParalinguisticTags` |
 *
 * ### Why the two engines differ deliberately
 *
 * Engine A supports acting instructions and paralinguistic tags; engine B supports neither, and
 * speaks a different set of languages. That is not padding: **25.9's tag-removal path and 25.3's
 * refusal are only reachable when the engines actually differ**, and a capability table where
 * every engine supported everything would make three of the four criteria above untestable. The
 * language sets overlap in `en` and `ko` but not in `ja` or `es`, so 25.3's "engines supporting
 * this language" answer is sometimes one engine, sometimes two, and sometimes none.
 *
 * ### These are declarations, not measurements
 *
 * **No TTS service is reachable from this environment**, so the capability table is what a
 * deployment declares about its engines, in the same sense `adapters/registry/engine-descriptor.ts`
 * holds declarations. The language lists in particular are a **product decision** — no requirement
 * names any language — and a real deployment replaces them. What the requirements fix is that the
 * lists exist, are presented (25.2) and are the basis of the refusal (25.3).
 */

import {
  TTS_PRIMARY_ENGINE_ID,
  TTS_SECONDARY_ENGINE_ID,
} from '../registry/default-engines';
import type { EngineLanguageSupport } from '../../domain/speech/language';

export interface TtsEngineCapabilities {
  readonly engineId: string;
  /** Requirements 25.2, 25.3 — ISO 639-1 codes, lowercase. */
  readonly languageCodes: readonly string[];
  /** Requirement 25.7 — 자연어 연기 지시 지원 여부. */
  readonly supportsActingInstruction: boolean;
  /** Requirements 25.8, 25.9 — 준언어 태그 지원 여부. */
  readonly supportsParalinguisticTags: boolean;
  /** Native output rate, for `normalizeEngineResult`'s `originalSampleRate`. */
  readonly sampleRate: number;
}

/**
 * Design §3.6's 기본 엔진 for `dialogue`.
 *
 * The richer of the two: acting instructions and tags, three languages. Design §3.6's note on the
 * row reads "엔진별 지원 언어 상이", which is the whole reason these two records differ.
 */
export const TTS_ENGINE_A_CAPABILITIES: TtsEngineCapabilities = {
  engineId: TTS_PRIMARY_ENGINE_ID,
  languageCodes: ['ko', 'en', 'ja'],
  supportsActingInstruction: true,
  supportsParalinguisticTags: true,
  sampleRate: 48_000,
};

/**
 * Design §3.6's 대체 엔진 for `dialogue`.
 *
 * Supports neither 25.7's direction nor 25.8's tags, and speaks `es` where engine A does not and
 * not `ja` where engine A does. A fallback that were a superset of the primary would make
 * Requirement 20.10's re-routing indistinguishable from not re-routing.
 */
export const TTS_ENGINE_B_CAPABILITIES: TtsEngineCapabilities = {
  engineId: TTS_SECONDARY_ENGINE_ID,
  languageCodes: ['en', 'ko', 'es'],
  supportsActingInstruction: false,
  supportsParalinguisticTags: false,
  sampleRate: 24_000,
};

/** Requirement 25.2: the two or more engines, in the order a picker shows them. */
export const TTS_ENGINE_CAPABILITIES: readonly TtsEngineCapabilities[] = [
  TTS_ENGINE_A_CAPABILITIES,
  TTS_ENGINE_B_CAPABILITIES,
];

export function ttsCapabilitiesOf(
  engineId: string,
  catalogue: readonly TtsEngineCapabilities[] = TTS_ENGINE_CAPABILITIES,
): TtsEngineCapabilities | undefined {
  return catalogue.find((entry) => entry.engineId === engineId);
}

/**
 * Requirements 25.2, 25.3's view of the capability table.
 *
 * A projection rather than a second list, so an engine can never appear in the language catalogue
 * with languages it does not declare.
 */
export function ttsLanguageCatalogue(
  catalogue: readonly TtsEngineCapabilities[] = TTS_ENGINE_CAPABILITIES,
): readonly EngineLanguageSupport[] {
  return catalogue.map((entry) => ({
    engineId: entry.engineId,
    languageCodes: entry.languageCodes,
  }));
}
