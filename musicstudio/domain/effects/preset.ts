/**
 * `Effect_Preset` — a named, reusable chain (Requirements 29.21–29.23, 29.35).
 *
 * Two populations share one type. Built-ins (29.21, at least four) are immutable and
 * ownerless; user presets (29.22) belong to an account and count against that account's
 * cap of 100 (29.35). `ownerId === null` is what distinguishes them, rather than a
 * separate `isBuiltIn` flag, because the two facts cannot then contradict each other —
 * Requirement 29.23's refusal is decidable from ownership alone.
 *
 * The built-in chains below are declared with literal parameter values, and every one
 * of those values is inside the ranges of Requirements 29.2–29.8. That is asserted, not
 * assumed: `test/unit/effects/preset.test.ts` validates all four through
 * `chainViolations`, so a future edit that reaches for a "nicer" reverb outside [0, 1]
 * fails there rather than at the worker.
 */

import { toChain, type EffectChain } from './chain';
import { EFFECT_NAME_MAX_LENGTH, EFFECT_NAME_MIN_LENGTH } from './registry';

export interface EffectPreset {
  readonly id: string;
  /** `null` for a built-in (Requirement 29.21); an account id for a user preset. */
  readonly ownerId: string | null;
  readonly name: string;
  readonly chain: EffectChain;
  readonly createdAtMs: number;
}

export function isBuiltInPreset(preset: EffectPreset): boolean {
  return preset.ownerId === null;
}

/** Requirement 29.22: 1–60 characters. */
export function isValidPresetName(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name.length >= EFFECT_NAME_MIN_LENGTH &&
    name.length <= EFFECT_NAME_MAX_LENGTH
  );
}

/**
 * A built-in definition before it becomes an `EffectPreset`.
 *
 * Declared as raw arrays and run through `toChain`, so the built-ins pass the same
 * validation as anything a user sends. A hand-built `EffectChain` literal would bypass
 * exactly the check that keeps 29.21's presets inside 29.2–29.8's ranges.
 */
interface BuiltInDefinition {
  readonly id: string;
  readonly name: string;
  readonly items: readonly { readonly kind: string; readonly parameters: Record<string, number> }[];
}

/**
 * Requirement 29.21: four built-in presets.
 *
 * Four, not more, because four is what the clause asks for ("4개 이상") and each one
 * added is a parameter set that has to be justified. These cover the four things a
 * creator reaches for first — space, width, control, and a lo-fi colour — and between
 * them exercise seven of the eight kinds, which makes them useful as fixtures too.
 *
 * `id` values are stable strings rather than generated UUIDs: a built-in is referenced
 * by clients and must survive a restart, so it cannot be identified by something minted
 * at start-up.
 */
const BUILT_IN_DEFINITIONS: readonly BuiltInDefinition[] = [
  {
    id: 'builtin_vocal_space',
    name: 'Vocal Space',
    items: [
      { kind: 'highpass', parameters: { cutoff_frequency_hz: 90 } },
      {
        kind: 'compressor',
        parameters: { threshold_db: -18, ratio: 3, attack_ms: 5, release_ms: 120 },
      },
      {
        kind: 'reverb',
        parameters: { room_size: 0.35, damping: 0.5, wet_level: 0.18, dry_level: 0.85, width: 1.0 },
      },
    ],
  },
  {
    id: 'builtin_wide_chorus',
    name: 'Wide Chorus',
    items: [
      {
        kind: 'chorus',
        parameters: { rate_hz: 0.8, depth: 0.3, feedback: 0.1, centre_delay_ms: 9, mix: 0.4 },
      },
      { kind: 'gain', parameters: { gain_db: -1.5 } },
    ],
  },
  {
    id: 'builtin_tape_slap',
    name: 'Tape Slap',
    items: [
      { kind: 'delay', parameters: { delay_seconds: 0.12, feedback: 0.25, mix: 0.3 } },
      { kind: 'lowpass', parameters: { cutoff_frequency_hz: 9000 } },
    ],
  },
  {
    id: 'builtin_lofi_telephone',
    name: 'Lo-Fi Telephone',
    items: [
      { kind: 'highpass', parameters: { cutoff_frequency_hz: 400 } },
      { kind: 'lowpass', parameters: { cutoff_frequency_hz: 3400 } },
      {
        kind: 'compressor',
        parameters: { threshold_db: -24, ratio: 8, attack_ms: 1, release_ms: 60 },
      },
      { kind: 'gain', parameters: { gain_db: 3 } },
    ],
  },
];

/**
 * The built-in presets (Requirement 29.21).
 *
 * `createdAtMs` is 0 rather than "now": a built-in has no creation event, and stamping
 * it with the process start time would make the same preset sort differently between
 * two servers. Requirement 29.17's promotion tie-break is over *versions*, not presets,
 * so nothing orders by this field — but a value that changed per process would be a
 * trap for whatever eventually did.
 */
export const BUILT_IN_PRESETS: readonly EffectPreset[] = BUILT_IN_DEFINITIONS.map(
  (definition) => ({
    id: definition.id,
    ownerId: null,
    name: definition.name,
    chain: toChain(definition.items),
    createdAtMs: 0,
  }),
);

export const BUILT_IN_PRESET_IDS: readonly string[] = BUILT_IN_PRESETS.map(
  (preset) => preset.id,
);

export function isBuiltInPresetId(id: string): boolean {
  return BUILT_IN_PRESET_IDS.includes(id);
}

export function findBuiltInPreset(id: string): EffectPreset | undefined {
  return BUILT_IN_PRESETS.find((preset) => preset.id === id);
}
