/**
 * The effect vocabulary and the parameter ranges of Requirements 29.1–29.8.
 *
 * This module is the **single declaration of those ranges on the TypeScript side**.
 * Nothing else in the product layer writes `0.95` or `-60` for an effect parameter;
 * validation (`chain.ts`), the parser (`chain-parser.ts`), the built-in presets
 * (`preset.ts`) and every generator in the property suites all read the table below.
 * A range that appeared in two places would eventually be corrected in one of them.
 *
 * ### Why this is a `bounds`-style table and not a Quality_Threshold_Set member
 *
 * `domain/quality/threshold-set.ts` holds the numbers an operator may retune —
 * perceptual judgements about whether audio is *good*. These are not that. A
 * compressor ratio of 0.5 is not poor-sounding, it is not a compressor; the ranges
 * here define which requests are *meaningful*, so they are structure in the sense
 * `domain/sfx/bounds.ts`, `domain/v2a/bounds.ts` and `domain/speech/bounds.ts` use
 * the word. Requirement 29.10 confirms the reading: an out-of-range parameter is
 * *refused* with the permitted range echoed back, which is validation behaviour, not
 * a quality verdict that could be relaxed per environment.
 *
 * ### Why the parameter names are these exact strings
 *
 * They are quoted verbatim from Requirements 29.2–29.8 (`rate_hz`, `centre_delay_ms`,
 * `cutoff_frequency_hz`, …), which in turn are `pedalboard`'s keyword arguments. That
 * coincidence is load-bearing and worth keeping: the DSP worker can splat a validated
 * parameter map straight into a `pedalboard` constructor, so there is no name-mapping
 * table to fall out of step with the requirement text. Renaming a parameter here would
 * silently break the worker, which is why `dsp/test/test_effects.py` asserts the names
 * against `pedalboard`'s own accepted keywords.
 *
 * ### How the Python side is kept in agreement
 *
 * The same table is checked in as `dsp/src/musicstudio_dsp/effect_registry.json`, and
 * the DSP worker *loads* that file rather than restating the numbers — so Python has
 * no second declaration that could drift. `test/unit/effects/registry-parity.test.ts`
 * compares this module against that JSON in both directions (every kind, every
 * parameter name, every bound), so a change on either side that is not mirrored fails
 * `npm test`. The JSON lives inside the DSP package so that it ships in the wheel;
 * a file under `domain/` would be absent from an installed worker.
 */

/** Requirement 29.1: the eight kinds, and no others. Order is the published order. */
export const EFFECT_KINDS = [
  'chorus',
  'reverb',
  'delay',
  'compressor',
  'gain',
  'highpass',
  'lowpass',
  'pitch_shift',
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/** An inclusive numeric range, as Requirements 29.2–29.8 state them ("이상 … 이하"). */
export interface ParameterRange {
  readonly min: number;
  readonly max: number;
}

export interface EffectDefinition {
  readonly kind: EffectKind;
  /**
   * Whether the effect can lengthen the signal (Requirements 29.30, 29.32).
   *
   * True for exactly `delay` and `reverb`: both have a feedback or decay path that
   * keeps emitting after the input ends. Requirement 29.30 exempts a chain
   * containing either from the length-preservation invariant, and 29.32 gives such a
   * chain a 10-second tail allowance instead. The flag lives beside the definition
   * rather than as a hard-coded pair of names in the service, so that the two
   * requirements read off one fact.
   */
  readonly extendsTail: boolean;
  readonly parameters: Readonly<Record<string, ParameterRange>>;
}

/**
 * Requirements 29.2–29.8, one entry per kind.
 *
 * Every parameter a kind accepts is listed. Requirement 29.9 refuses *unregistered*
 * parameter names, so this table is exhaustive by construction: a name absent here is
 * a name that does not exist.
 */
export const EFFECT_REGISTRY: Readonly<Record<EffectKind, EffectDefinition>> = {
  // Requirement 29.2. Covers 29.1's "코러스/플랜저" — a flanger is this with a short
  // centre delay and high feedback, which is why the two are one kind and why
  // `centre_delay_ms` reaches down to 0.5 ms.
  chorus: {
    kind: 'chorus',
    extendsTail: false,
    parameters: {
      rate_hz: { min: 0.01, max: 20 },
      depth: { min: 0.0, max: 1.0 },
      feedback: { min: 0.0, max: 0.95 },
      centre_delay_ms: { min: 0.5, max: 50 },
      mix: { min: 0.0, max: 1.0 },
    },
  },

  // Requirement 29.3: all five normalised to [0, 1].
  reverb: {
    kind: 'reverb',
    extendsTail: true,
    parameters: {
      room_size: { min: 0.0, max: 1.0 },
      damping: { min: 0.0, max: 1.0 },
      wet_level: { min: 0.0, max: 1.0 },
      dry_level: { min: 0.0, max: 1.0 },
      width: { min: 0.0, max: 1.0 },
    },
  },

  // Requirement 29.4.
  delay: {
    kind: 'delay',
    extendsTail: true,
    parameters: {
      delay_seconds: { min: 0.01, max: 2.0 },
      feedback: { min: 0.0, max: 0.95 },
      mix: { min: 0.0, max: 1.0 },
    },
  },

  // Requirement 29.5.
  compressor: {
    kind: 'compressor',
    extendsTail: false,
    parameters: {
      threshold_db: { min: -60, max: 0 },
      ratio: { min: 1.0, max: 20.0 },
      attack_ms: { min: 0.1, max: 100 },
      release_ms: { min: 10, max: 1000 },
    },
  },

  // Requirement 29.6.
  gain: {
    kind: 'gain',
    extendsTail: false,
    parameters: {
      gain_db: { min: -40, max: 40 },
    },
  },

  // Requirement 29.7. The two filters share a parameter name and deliberately do not
  // share a range: a high-pass at 20 kHz would remove everything audible, and a
  // low-pass at 20 Hz likewise, so each is bounded to the half of the spectrum where
  // it does something.
  highpass: {
    kind: 'highpass',
    extendsTail: false,
    parameters: {
      cutoff_frequency_hz: { min: 20, max: 8000 },
    },
  },

  lowpass: {
    kind: 'lowpass',
    extendsTail: false,
    parameters: {
      cutoff_frequency_hz: { min: 200, max: 20000 },
    },
  },

  // Requirement 29.8. The same clause also requires that pitch shifting preserve the
  // time axis rather than changing playback speed; that is a property of the
  // implementation (`dsp/src/musicstudio_dsp/effects.py`) and is why this kind is not
  // tail-extending.
  pitch_shift: {
    kind: 'pitch_shift',
    extendsTail: false,
    parameters: {
      semitones: { min: -12, max: 12 },
    },
  },
};

/** Requirement 29.13: items per chain, both ends inclusive. */
export const CHAIN_ITEM_COUNT_MIN = 1;
export const CHAIN_ITEM_COUNT_MAX = 16;

/**
 * Requirement 29.26's comparison tolerance for numeric parameters.
 *
 * Quoted from the clause (`0.000001`). It exists because a chain travels through JSON
 * and back, and a printer that shortened `0.30000000000000004` to `0.3` would be
 * doing the right thing while failing exact equality.
 */
export const CHAIN_PARAMETER_TOLERANCE = 0.000001;

/** Requirements 29.20, 29.22: the version/preset name bound. */
export const EFFECT_NAME_MIN_LENGTH = 1;
export const EFFECT_NAME_MAX_LENGTH = 60;

/** Requirement 29.19: versions per asset, original included. */
export const MAX_VERSIONS_PER_ASSET = 16;

/** Requirement 29.35: user-owned presets per user. */
export const MAX_PRESETS_PER_USER = 100;

/** Requirement 29.32: tail allowance for a chain containing delay or reverb. */
export const EFFECT_TAIL_ALLOWANCE_MS = 10_000;

/** Requirement 29.30: length-preservation tolerance for every other chain. */
export const EFFECT_LENGTH_TOLERANCE_MS = 10;

export function isEffectKind(value: unknown): value is EffectKind {
  return typeof value === 'string' && Object.hasOwn(EFFECT_REGISTRY, value);
}

export function effectDefinition(kind: EffectKind): EffectDefinition {
  return EFFECT_REGISTRY[kind];
}

/** The parameter names a kind accepts, in declaration order. */
export function parameterNames(kind: EffectKind): readonly string[] {
  return Object.keys(EFFECT_REGISTRY[kind].parameters);
}

export function parameterRange(kind: EffectKind, parameter: string): ParameterRange | undefined {
  const ranges = EFFECT_REGISTRY[kind].parameters;
  return Object.hasOwn(ranges, parameter) ? ranges[parameter] : undefined;
}

/**
 * Whether a value sits inside a kind's range for a parameter.
 *
 * Non-finite values are rejected before the comparison. `NaN` fails both `<` and `>`,
 * so a bare range check would *accept* it; Requirement 29.10 plainly does not mean
 * that, and a `NaN` reaching `pedalboard` would poison every subsequent sample.
 */
export function isParameterInRange(
  kind: EffectKind,
  parameter: string,
  value: unknown,
): boolean {
  const range = parameterRange(kind, parameter);
  if (range === undefined) return false;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return value >= range.min && value <= range.max;
}

/** Requirement 29.10's payload: the range, rendered for the caller. */
export function describeRange(range: ParameterRange): string {
  return `${String(range.min)}..${String(range.max)}`;
}

/** Requirements 29.30, 29.32: does this chain contain a tail-extending effect? */
export function chainExtendsTail(kinds: readonly EffectKind[]): boolean {
  return kinds.some((kind) => EFFECT_REGISTRY[kind].extendsTail);
}
