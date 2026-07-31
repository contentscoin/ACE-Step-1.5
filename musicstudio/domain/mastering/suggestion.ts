/**
 * The mastering suggestion (Requirements 30.1–30.4, 30.21, 30.22, 30.23).
 *
 * A suggestion is an `Effect_Chain` plus the measurements that motivated it plus a label
 * saying where it came from. All three parts are demanded separately by the requirement:
 * 30.1 the chain and its parameter values in a form the user can inspect, 30.22 the
 * loudness/true-peak/band-energy report, 30.21 the source as one of two values.
 *
 * ### Requirement 30.2 is an invariant, so it is checked here
 *
 * "제안된 Effect_Chain의 모든 파라미터 값을 Requirement 29에 정의된 허용 범위 안의 값으로
 * 산출한다(불변식)". A model produces the chain, and a model is not bound by our ranges —
 * so `suggestionDefects` runs the chain through the *same* `chainViolations` a user request
 * goes through. A suggestion that fails is refused rather than clamped, because clamping
 * would return values the model did not choose while labelling them a model suggestion.
 * `services/mastering/mastering-assistant.ts` falls back to the built-in in that case,
 * which is the behaviour Requirement 30.21 already describes for an unavailable service —
 * a service that answers with something unusable is, for this purpose, unavailable.
 *
 * ### Requirement 30.3 keeps both chains
 *
 * "수정된 값으로 처리를 수행하고 원래 제안 값을 함께 보관한다". So an applied suggestion is
 * a pair, not an overwrite: `suggested` is what came back, `applied` is what the user ran.
 * They are equal when the user changed nothing, and `wasEdited` reads off the equivalence
 * relation of Requirement 29.26 rather than a deep object compare — two chains that differ
 * only by float noise below `CHAIN_PARAMETER_TOLERANCE` are the same chain, and calling
 * that an edit would be wrong.
 *
 * ### Requirement 30.23 is carried, not decided
 *
 * The suggestion records the model's `commercialUseAllowed`. Folding it into the asset is
 * `domain/commercial-use.ts`'s job through `resolveCommercialUseOnWrite`, and the gate that
 * refuses commercial use is Requirement 33.22's fixed policy. Nothing here can widen
 * permission: the field is an input to a conjunction.
 */

import { OCTAVE_BAND_COUNT } from './bounds';
import { isWellFormedMeasurement, type MasteringMeasurement } from './measurement';

import { chainViolations, type EffectChain } from '../effects/chain';
import type { ChainViolation } from '../effects/chain';
import { chainsEquivalent } from '../effects/equivalence';
import { findBuiltInPreset } from '../effects/preset';

/**
 * Requirement 30.21's two values, and no others.
 *
 * A closed list rather than a boolean, because the clause says "모델 제안 또는 기본 제안 중
 * 하나의 값" — a named value the client can display — and because a third source (a user's
 * own saved preset, say) would be an addition to this list rather than a reinterpretation
 * of a flag.
 */
export const SUGGESTION_SOURCES = ['model', 'builtin'] as const;
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number];

/** The preset Requirement 30.21's fallback is built from. */
export const FALLBACK_PRESET_ID = 'builtin_master_bus';

export interface MasteringSuggestion {
  /** Requirement 30.1: the chain and every parameter value, inspectable. */
  readonly chain: EffectChain;
  /** Requirement 30.21. */
  readonly source: SuggestionSource;
  /** Requirement 30.22: the measurements the suggestion was made against. */
  readonly measurement: MasteringMeasurement;
  /** Which engine produced it; `null` for the built-in fallback. */
  readonly engineId: string | null;
  /**
   * Requirement 30.23: the suggesting model's licence permission.
   *
   * `true` for the built-in fallback, which is our own preset and carries no third-party
   * licence — so falling back cannot *reduce* an asset's permission, and reaching a
   * non-commercial model cannot fail to reduce it.
   */
  readonly commercialUseAllowed: boolean;
}

export type SuggestionDefect =
  /** Requirement 30.2: a parameter outside Requirement 29's ranges. */
  | { readonly kind: 'chain_out_of_range'; readonly violations: readonly ChainViolation[] }
  /** Requirement 30.22: the band report is not the ten bands, in order. */
  | { readonly kind: 'measurement_malformed'; readonly expectedBands: number }
  /** A `model` source with no engine named, or a `builtin` source claiming one. */
  | { readonly kind: 'source_engine_mismatch' };

/**
 * Requirements 30.2 and 30.22 as one total check on what came back from a model.
 *
 * Both clauses are invariants about the *response*, and the response crosses a process
 * boundary, so neither can be assumed. The `source_engine_mismatch` case is not from the
 * requirement text: it catches a suggestion labelled `builtin` that names an engine, which
 * would make Requirement 30.21's provenance label a lie, and one labelled `model` that
 * names none, which would leave Requirement 30.23 unable to find a licence to read.
 */
export function suggestionDefects(
  suggestion: MasteringSuggestion,
): readonly SuggestionDefect[] {
  const defects: SuggestionDefect[] = [];

  const violations = chainViolations(suggestion.chain.items);
  if (violations.length > 0) {
    defects.push({ kind: 'chain_out_of_range', violations });
  }
  if (!isWellFormedMeasurement(suggestion.measurement)) {
    defects.push({ kind: 'measurement_malformed', expectedBands: OCTAVE_BAND_COUNT });
  }
  if (
    (suggestion.source === 'model') !== (suggestion.engineId !== null) ||
    (suggestion.source === 'builtin' && suggestion.engineId !== null)
  ) {
    defects.push({ kind: 'source_engine_mismatch' });
  }

  return defects;
}

export function isUsableSuggestion(suggestion: MasteringSuggestion): boolean {
  return suggestionDefects(suggestion).length === 0;
}

/**
 * Requirement 30.21's default suggestion, from the built-in preset.
 *
 * Synchronous and allocation-only — no port, no I/O, no clock — which is what makes the
 * clause's 5-second budget trivially satisfiable rather than something to measure. The
 * measurement is passed in because it was already taken before the model was called: the
 * fallback replaces the *suggestion*, not the analysis.
 */
export function builtInSuggestion(measurement: MasteringMeasurement): MasteringSuggestion {
  const preset = findBuiltInPreset(FALLBACK_PRESET_ID);
  if (preset === undefined) {
    // Unreachable while `FALLBACK_PRESET_ID` names a member of `BUILT_IN_PRESETS`, which
    // `test/unit/mastering/suggestion.test.ts` pins. Thrown rather than returning an empty
    // chain, because an empty chain would violate Requirement 29.13's minimum of one item
    // and quietly turn Requirement 30.21's fallback into a no-op.
    throw new Error(`built-in mastering preset '${FALLBACK_PRESET_ID}' is missing`);
  }

  return {
    chain: preset.chain,
    source: 'builtin',
    measurement,
    engineId: null,
    commercialUseAllowed: true,
  };
}

export interface AppliedSuggestion {
  /** Requirement 30.3: the original suggestion, kept whether or not it was edited. */
  readonly suggested: EffectChain;
  /** Requirement 30.3: what was actually processed. */
  readonly applied: EffectChain;
  readonly source: SuggestionSource;
  readonly engineId: string | null;
}

/** Requirement 30.3: did the user change the suggestion? Chain equivalence, not identity. */
export function wasEdited(applied: AppliedSuggestion): boolean {
  return !chainsEquivalent(applied.suggested, applied.applied);
}
