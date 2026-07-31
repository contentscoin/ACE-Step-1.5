import { describe, expect, it } from 'vitest';

import { chainViolations, toChain } from '../../../domain/effects/chain';
import { BUILT_IN_PRESETS, findBuiltInPreset } from '../../../domain/effects/preset';
import {
  FALLBACK_PRESET_ID,
  SUGGESTION_SOURCES,
  builtInSuggestion,
  isUsableSuggestion,
  suggestionDefects,
  wasEdited,
} from '../../../domain/mastering/suggestion';
import {
  OUT_OF_RANGE_SUGGESTION_ITEMS,
  VALID_SUGGESTION_ITEMS,
  measurement,
} from '../../support/mastering-harness';

/**
 * The mastering suggestion.
 *
 * **Validates: Requirements 30.1, 30.2, 30.3, 30.21, 30.22, 30.23, 29.21**
 *
 * Requirement 30.2 is stated as an invariant over a *model's* output, and a model is not
 * bound by our parameter ranges — so the tests that matter are the ones proving an
 * out-of-range suggestion is caught rather than clamped, and that the built-in fallback is
 * itself inside the ranges.
 */

describe('the source label (Requirement 30.21)', () => {
  it('has exactly the two values the clause names', () => {
    expect([...SUGGESTION_SOURCES]).toEqual(['model', 'builtin']);
  });

  it('pairs `model` with an engine and `builtin` with none', () => {
    // A `builtin` suggestion naming an engine would make the provenance label a lie; a
    // `model` suggestion naming none would leave Requirement 30.23 with no licence to read.
    expect(
      suggestionDefects({
        chain: toChain(VALID_SUGGESTION_ITEMS),
        source: 'builtin',
        measurement: measurement(),
        engineId: 'deepafx-mastering-v1',
        commercialUseAllowed: true,
      }),
    ).toContainEqual({ kind: 'source_engine_mismatch' });

    expect(
      suggestionDefects({
        chain: toChain(VALID_SUGGESTION_ITEMS),
        source: 'model',
        measurement: measurement(),
        engineId: null,
        commercialUseAllowed: false,
      }),
    ).toContainEqual({ kind: 'source_engine_mismatch' });
  });
});

describe('Requirement 30.2 — every suggested parameter is inside Requirement 29\u2019s ranges', () => {
  it('accepts a chain the ranges permit', () => {
    expect(
      isUsableSuggestion({
        chain: toChain(VALID_SUGGESTION_ITEMS),
        source: 'model',
        measurement: measurement(),
        engineId: 'deepafx-mastering-v1',
        commercialUseAllowed: false,
      }),
    ).toBe(true);
  });

  it('refuses a chain with an out-of-range parameter, and reports the violations', () => {
    // The chain is assembled *without* `toChain`, because `toChain` already throws on an
    // out-of-range parameter — which is how the model path in
    // `services/mastering/mastering-assistant.ts` actually rejects a bad suggestion, and is
    // tested there. This check is the second line: an `EffectChain` built as a literal,
    // bypassing the parser, must still be caught rather than trusted, because Requirement
    // 30.2 is an invariant about the suggestion and not about how it was constructed.
    const defects = suggestionDefects({
      chain: { items: [...OUT_OF_RANGE_SUGGESTION_ITEMS] },
      source: 'model',
      measurement: measurement(),
      engineId: 'deepafx-mastering-v1',
      commercialUseAllowed: false,
    });

    const defect = defects.find((entry) => entry.kind === 'chain_out_of_range');
    if (defect?.kind !== 'chain_out_of_range') throw new Error('expected a range defect');
    expect(defect.violations.length).toBeGreaterThan(0);
  });

  it('refuses the out-of-range chain at the parser too, which is the first line', () => {
    expect(() => toChain(OUT_OF_RANGE_SUGGESTION_ITEMS)).toThrow(/parameter_out_of_range/);
  });

  it('uses the same validation a user request goes through', () => {
    // Not a parallel implementation: the invariant is checked with `chainViolations`, so a
    // range change in `domain/effects/registry.ts` moves both at once.
    expect(chainViolations([...OUT_OF_RANGE_SUGGESTION_ITEMS]).length).toBeGreaterThan(0);
  });
});

describe('Requirement 30.22 — the measurement travels with the suggestion', () => {
  it('refuses a suggestion whose band report is malformed', () => {
    const defects = suggestionDefects({
      chain: toChain(VALID_SUGGESTION_ITEMS),
      source: 'model',
      measurement: measurement({ octaveBands: measurement().octaveBands.slice(0, 5) }),
      engineId: 'deepafx-mastering-v1',
      commercialUseAllowed: false,
    });

    expect(defects).toContainEqual({ kind: 'measurement_malformed', expectedBands: 10 });
  });
});

describe('Requirement 30.21 — the built-in fallback', () => {
  it('is built from a real built-in Effect_Preset', () => {
    // The clause says "내장 Effect_Preset 기반", so the fallback has to *be* one rather than
    // a chain invented here.
    expect(findBuiltInPreset(FALLBACK_PRESET_ID)).toBeDefined();
    expect(BUILT_IN_PRESETS.map((preset) => preset.id)).toContain(FALLBACK_PRESET_ID);
  });

  it('keeps Requirement 29.21\u2019s population at four or more', () => {
    expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(4);
  });

  it('is inside Requirement 29\u2019s ranges, so it satisfies 30.2 too', () => {
    const suggestion = builtInSuggestion(measurement());

    expect(chainViolations(suggestion.chain.items)).toEqual([]);
    expect(isUsableSuggestion(suggestion)).toBe(true);
  });

  it('is labelled `builtin` and names no engine', () => {
    const suggestion = builtInSuggestion(measurement());

    expect(suggestion.source).toBe('builtin');
    expect(suggestion.engineId).toBeNull();
  });

  it('permits commercial use, so falling back cannot reduce an asset\u2019s permission', () => {
    // Our own preset carries no third-party licence. The converse — a non-commercial model
    // reducing permission — is `deepafx-adapter.test.ts`'s.
    expect(builtInSuggestion(measurement()).commercialUseAllowed).toBe(true);
  });

  it('carries the measurement it was handed', () => {
    // The fallback replaces the *suggestion*, not the analysis: Requirement 30.22 puts the
    // measurements in the response whichever source answered.
    const source = measurement({ integratedLoudnessLufs: -22.4 });

    expect(builtInSuggestion(source).measurement).toBe(source);
  });

  it('applies no make-up gain, leaving level to the normalisation step', () => {
    // Deliberate: the loudness target is pursued by `normaliseLoudness`, which enforces
    // Requirement 30.7's ceiling. A gain here would fight it.
    const gainItem = builtInSuggestion(measurement()).chain.items.find(
      (item) => item.kind === 'gain',
    );

    expect(gainItem?.parameters.gain_db).toBe(0);
  });
});

describe('Requirement 30.3 — the original suggestion is kept alongside the applied one', () => {
  it('reports no edit when the two chains are equivalent', () => {
    const chain = toChain(VALID_SUGGESTION_ITEMS);

    expect(
      wasEdited({ suggested: chain, applied: chain, source: 'model', engineId: 'e' }),
    ).toBe(false);
  });

  it('reports no edit for a difference below the equivalence tolerance', () => {
    // Requirement 29.26's tolerance is 1e-6, and a chain that has been through JSON may
    // differ by float noise. Calling that an edit would be wrong.
    const suggested = toChain(VALID_SUGGESTION_ITEMS);
    const applied = toChain([
      { kind: 'highpass', parameters: { cutoff_frequency_hz: 35 + 1e-9 } },
      {
        kind: 'compressor',
        parameters: { threshold_db: -14, ratio: 2.5, attack_ms: 25, release_ms: 200 },
      },
    ]);

    expect(wasEdited({ suggested, applied, source: 'model', engineId: 'e' })).toBe(false);
  });

  it('reports an edit when the user actually changed a value', () => {
    const suggested = toChain(VALID_SUGGESTION_ITEMS);
    const applied = toChain([
      { kind: 'highpass', parameters: { cutoff_frequency_hz: 80 } },
      {
        kind: 'compressor',
        parameters: { threshold_db: -14, ratio: 2.5, attack_ms: 25, release_ms: 200 },
      },
    ]);

    expect(wasEdited({ suggested, applied, source: 'model', engineId: 'e' })).toBe(true);
  });

  it('keeps both chains reachable, which is the whole point of the pair', () => {
    const suggested = toChain(VALID_SUGGESTION_ITEMS);
    const applied = toChain([{ kind: 'gain', parameters: { gain_db: -2 } }]);
    const record = { suggested, applied, source: 'model' as const, engineId: 'e' };

    expect(record.suggested).toBe(suggested);
    expect(record.applied).toBe(applied);
  });
});
