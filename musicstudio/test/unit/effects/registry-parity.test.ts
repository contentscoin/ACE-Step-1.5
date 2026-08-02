import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHAIN_ITEM_COUNT_MAX,
  CHAIN_ITEM_COUNT_MIN,
  CHAIN_PARAMETER_TOLERANCE,
  EFFECT_KINDS,
  EFFECT_LENGTH_TOLERANCE_MS,
  EFFECT_REGISTRY,
  EFFECT_TAIL_ALLOWANCE_MS,
} from '../../../domain/effects/registry';

/**
 * Parity guard between `domain/effects/registry.ts` and
 * `dsp/src/musicstudio_dsp/effect_registry.json`.
 *
 * **Validates: Requirements 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7, 29.8, 29.13, 29.26,
 * 29.30, 29.32**
 *
 * Requirements 29.2–29.8's ranges have to be enforced twice — once in the product layer so a
 * bad request is refused *before* work is queued (which is what makes 29.10's synchronous
 * response possible), and once in the DSP worker so the queue is not a way around them. Two
 * enforcement points mean two chances to be wrong, and they are only "the same ranges" for as
 * long as something checks.
 *
 * This suite is that check, and it is the reason the Python side has no hand-written table:
 * `effects.py` *loads* the JSON, so the worker cannot drift by editing a constant. What
 * remains is drift between this module and the JSON, which is what the assertions below
 * cover — in **both directions**, because a one-way check would accept a JSON file that had
 * quietly grown a ninth effect.
 *
 * No Python process is started and no database is needed, so this runs in the fast loop
 * alongside the schema-parity suites of tasks 1.1, 2.7 and 6.2.
 */

const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../dsp/src/musicstudio_dsp/effect_registry.json', import.meta.url),
);

interface JsonRange {
  readonly min: number;
  readonly max: number;
}

interface JsonEffect {
  readonly extends_tail: boolean;
  readonly parameters: Record<string, JsonRange>;
}

interface JsonRegistry {
  readonly chain_item_count_min: number;
  readonly chain_item_count_max: number;
  readonly parameter_tolerance: number;
  readonly tail_allowance_ms: number;
  readonly length_tolerance_ms: number;
  readonly effects: Record<string, JsonEffect>;
}

const shared = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as JsonRegistry;

describe('effect vocabulary parity (Requirement 29.1)', () => {
  it('declares the same eight kinds, in the same order', () => {
    // Order matters: it is the published order of the kind list, and the Python
    // `EFFECT_KINDS` tuple is built from the JSON's key order.
    expect(Object.keys(shared.effects)).toEqual([...EFFECT_KINDS]);
  });

  it('has exactly eight kinds, as Requirement 29.1 enumerates', () => {
    expect(EFFECT_KINDS).toHaveLength(8);
    expect(Object.keys(shared.effects)).toHaveLength(8);
  });
});

describe('parameter range parity (Requirements 29.2–29.8)', () => {
  for (const kind of EFFECT_KINDS) {
    describe(kind, () => {
      it('declares the same parameter names, in the same order', () => {
        const jsonEffect = shared.effects[kind];
        expect(jsonEffect).toBeDefined();
        expect(Object.keys(jsonEffect?.parameters ?? {})).toEqual(
          Object.keys(EFFECT_REGISTRY[kind].parameters),
        );
      });

      it('declares the same bounds for every parameter', () => {
        const jsonEffect = shared.effects[kind];
        for (const [name, range] of Object.entries(EFFECT_REGISTRY[kind].parameters)) {
          const jsonRange = jsonEffect?.parameters[name];
          expect(jsonRange, `${kind}.${name} missing from the JSON registry`).toBeDefined();
          expect(jsonRange?.min, `${kind}.${name} min`).toBe(range.min);
          expect(jsonRange?.max, `${kind}.${name} max`).toBe(range.max);
        }
      });

      it('agrees on whether the effect can lengthen the signal', () => {
        // Requirements 29.30 and 29.32 branch on this flag, so a disagreement would
        // make the two sides apply different length invariants to the same chain.
        expect(shared.effects[kind]?.extends_tail).toBe(EFFECT_REGISTRY[kind].extendsTail);
      });
    });
  }

  it('marks exactly delay and reverb as tail-extending (Requirements 29.30, 29.32)', () => {
    const extending = EFFECT_KINDS.filter((kind) => EFFECT_REGISTRY[kind].extendsTail);
    expect([...extending].sort()).toEqual(['delay', 'reverb']);
  });
});

describe('shared scalar parity (Requirements 29.13, 29.26, 29.30, 29.32)', () => {
  it('agrees on the chain item count bounds', () => {
    expect(shared.chain_item_count_min).toBe(CHAIN_ITEM_COUNT_MIN);
    expect(shared.chain_item_count_max).toBe(CHAIN_ITEM_COUNT_MAX);
  });

  it('agrees on the equivalence tolerance', () => {
    expect(shared.parameter_tolerance).toBe(CHAIN_PARAMETER_TOLERANCE);
  });

  it('agrees on the tail allowance and the length tolerance', () => {
    expect(shared.tail_allowance_ms).toBe(EFFECT_TAIL_ALLOWANCE_MS);
    expect(shared.length_tolerance_ms).toBe(EFFECT_LENGTH_TOLERANCE_MS);
  });
});

describe('the ranges are the ones Requirements 29.2–29.8 quote', () => {
  /**
   * Spot-checks against the requirement text rather than against the other file.
   *
   * Parity alone would be satisfied by two files that agreed and were both wrong. These
   * assertions are the literal numbers from the clauses, so a transcription error is
   * caught even though both declarations contain it.
   */
  it('29.2 — chorus', () => {
    expect(EFFECT_REGISTRY.chorus.parameters).toEqual({
      rate_hz: { min: 0.01, max: 20 },
      depth: { min: 0, max: 1 },
      feedback: { min: 0, max: 0.95 },
      centre_delay_ms: { min: 0.5, max: 50 },
      mix: { min: 0, max: 1 },
    });
  });

  it('29.3 — reverb, all five in [0, 1]', () => {
    for (const range of Object.values(EFFECT_REGISTRY.reverb.parameters)) {
      expect(range).toEqual({ min: 0, max: 1 });
    }
    expect(Object.keys(EFFECT_REGISTRY.reverb.parameters)).toEqual([
      'room_size',
      'damping',
      'wet_level',
      'dry_level',
      'width',
    ]);
  });

  it('29.4 — delay', () => {
    expect(EFFECT_REGISTRY.delay.parameters).toEqual({
      delay_seconds: { min: 0.01, max: 2 },
      feedback: { min: 0, max: 0.95 },
      mix: { min: 0, max: 1 },
    });
  });

  it('29.5 — compressor', () => {
    expect(EFFECT_REGISTRY.compressor.parameters).toEqual({
      threshold_db: { min: -60, max: 0 },
      ratio: { min: 1, max: 20 },
      attack_ms: { min: 0.1, max: 100 },
      release_ms: { min: 10, max: 1000 },
    });
  });

  it('29.6 — gain', () => {
    expect(EFFECT_REGISTRY.gain.parameters).toEqual({ gain_db: { min: -40, max: 40 } });
  });

  it('29.7 — the two filters have different ranges', () => {
    expect(EFFECT_REGISTRY.highpass.parameters.cutoff_frequency_hz).toEqual({
      min: 20,
      max: 8000,
    });
    expect(EFFECT_REGISTRY.lowpass.parameters.cutoff_frequency_hz).toEqual({
      min: 200,
      max: 20000,
    });
  });

  it('29.8 — pitch shift', () => {
    expect(EFFECT_REGISTRY.pitch_shift.parameters).toEqual({ semitones: { min: -12, max: 12 } });
  });

  it('29.13, 29.26, 29.32 — the scalars', () => {
    expect(CHAIN_ITEM_COUNT_MIN).toBe(1);
    expect(CHAIN_ITEM_COUNT_MAX).toBe(16);
    expect(CHAIN_PARAMETER_TOLERANCE).toBe(0.000001);
    expect(EFFECT_TAIL_ALLOWANCE_MS).toBe(10_000);
    expect(EFFECT_LENGTH_TOLERANCE_MS).toBe(10);
  });
});
