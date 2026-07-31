/**
 * `Effect_Preset` CRUD (Requirements 29.21–29.23, 29.35).
 *
 * Same shape as `version-manager.ts`: pure functions over the caller's current preset
 * list, returning either the new list or a refusal carrying the payload the clause asks
 * for. Identifiers and timestamps arrive as arguments.
 *
 * ### The two rules that need care
 *
 * **29.35's cap counts user presets only.** "사용자당 Effect_Preset 개수를 100개 이하로
 * 유지하며, 101번째 프리셋 생성 요청을 거부" — the four built-ins are not "사용자당"
 * anything; they are ownerless and visible to everyone, so counting them would silently
 * cost every user four slots. `listPresets` therefore returns built-ins *and* the user's
 * own, while `createPreset` counts only the owned ones against the cap. The distinction is
 * asserted in `test/unit/effects/preset-service.test.ts`.
 *
 * **29.23 forbids modifying or deleting a built-in, and requires nothing change.** The
 * clause is explicit that the preset's name and chain must be left alone, which is why
 * both mutating operations refuse *before* constructing anything and why nothing here
 * mutates in place. `BUILT_IN_PRESETS` is a module-level frozen-by-convention constant; a
 * function that edited an element of it would corrupt the built-in set for the whole
 * process, so no function takes that path.
 */

import {
  BUILT_IN_PRESETS,
  MAX_PRESETS_PER_USER,
  chainViolations,
  isBuiltInPresetId,
  isValidPresetName,
  toChain,
  type EffectPreset,
} from '../../domain/effects';
import {
  EFFECT_NAME_MAX_LENGTH,
  EFFECT_NAME_MIN_LENGTH,
} from '../../domain/effects/registry';
import type { ChainViolation } from '../../domain/effects/chain';

export type PresetRefusalCode =
  /** Requirement 29.35: the owner already holds 100 presets. */
  | 'preset_limit_reached'
  /** Requirement 29.23: built-in presets are immutable. */
  | 'builtin_preset_immutable'
  | 'preset_not_found'
  /** Requirement 29.22: name outside 1–60 characters. */
  | 'preset_name_invalid'
  /** Requirements 29.9, 29.10, 29.13 via 29.22's "해당 Effect_Chain". */
  | 'preset_chain_invalid'
  | 'preset_not_owned';

export interface PresetRefusal {
  readonly ok: false;
  readonly code: PresetRefusalCode;
  /** Requirement 29.35: the count and the cap travel with the refusal. */
  readonly currentCount?: number;
  readonly limit?: number;
  readonly presetId?: string;
  readonly chainViolations?: readonly ChainViolation[];
  readonly detail?: string;
}

export interface PresetChange {
  readonly ok: true;
  /** The owner's complete preset list after the operation. Built-ins excluded. */
  readonly presets: readonly EffectPreset[];
  readonly preset?: EffectPreset;
  readonly removed?: EffectPreset;
}

export type PresetOutcome = PresetChange | PresetRefusal;

function refuse(code: PresetRefusalCode, rest: Partial<PresetRefusal> = {}): PresetRefusal {
  return { ok: false, code, ...rest };
}

/**
 * Requirement 29.21: what a user can choose from — the built-ins plus their own.
 *
 * Built-ins first, so the list a client renders is stable regardless of how many presets
 * the user has saved.
 */
export function listPresets(ownedPresets: readonly EffectPreset[]): readonly EffectPreset[] {
  return [...BUILT_IN_PRESETS, ...ownedPresets];
}

/** Requirement 29.35's subject: presets that count against the cap. */
export function ownedPresetCount(
  ownerId: string,
  presets: readonly EffectPreset[],
): number {
  return presets.filter((preset) => preset.ownerId === ownerId).length;
}

export interface CreatePresetInput {
  readonly ownerId: string;
  readonly presets: readonly EffectPreset[];
  readonly presetId: string;
  readonly name: string;
  /** Raw items, validated here. Requirement 29.22 requires a 1–16 item chain. */
  readonly chain: unknown;
  readonly createdAtMs: number;
}

/**
 * Requirements 29.22, 29.35: save a chain as a user-owned preset.
 *
 * The chain is validated through `chainViolations` — the same function the parser and the
 * service use — so a preset cannot become the way an out-of-range parameter enters the
 * system. Requirement 29.22's "1개 이상 16개 이하 이펙트 항목" is part of that check
 * (Requirement 29.13), not a second count rule here.
 *
 * The cap is checked *before* the chain, so a user at 100 presets is told they are at 100
 * rather than being sent to fix a chain that would be refused anyway. Both are reported
 * when both apply would be friendlier, but 29.35 asks for the count and the limit as the
 * response to a 101st creation, and the clause reads as a single refusal.
 */
export function createPreset(input: CreatePresetInput): PresetOutcome {
  const currentCount = ownedPresetCount(input.ownerId, input.presets);

  // Requirement 29.35.
  if (currentCount >= MAX_PRESETS_PER_USER) {
    return refuse('preset_limit_reached', { currentCount, limit: MAX_PRESETS_PER_USER });
  }

  if (!isValidPresetName(input.name)) {
    return refuse('preset_name_invalid', {
      detail: `${String(EFFECT_NAME_MIN_LENGTH)}..${String(EFFECT_NAME_MAX_LENGTH)} characters`,
    });
  }

  const violations = chainViolations(input.chain);
  if (violations.length > 0) {
    return refuse('preset_chain_invalid', { chainViolations: violations });
  }

  const preset: EffectPreset = {
    id: input.presetId,
    ownerId: input.ownerId,
    name: input.name,
    chain: toChain(input.chain),
    createdAtMs: input.createdAtMs,
  };

  return { ok: true, presets: [...input.presets, preset], preset };
}

export interface UpdatePresetInput {
  readonly ownerId: string;
  readonly presets: readonly EffectPreset[];
  readonly presetId: string;
  readonly name?: string;
  readonly chain?: unknown;
}

/**
 * Rename a preset or replace its chain (Requirement 29.23's negative case included).
 *
 * A built-in id is refused first and by id, not by looking the preset up in the caller's
 * list. A user's own list never contains a built-in, so a lookup-based check would report
 * `preset_not_found` for an attempt to edit `builtin_vocal_space` — technically true of
 * that list, but Requirement 29.23 asks specifically for the immutability reason, and a
 * client cannot distinguish "does not exist" from "may not be changed" without it.
 */
export function updatePreset(input: UpdatePresetInput): PresetOutcome {
  // Requirement 29.23.
  if (isBuiltInPresetId(input.presetId)) {
    return refuse('builtin_preset_immutable', { presetId: input.presetId });
  }

  const existing = input.presets.find((preset) => preset.id === input.presetId);
  if (existing === undefined) return refuse('preset_not_found', { presetId: input.presetId });
  if (existing.ownerId !== input.ownerId) {
    return refuse('preset_not_owned', { presetId: input.presetId });
  }

  if (input.name !== undefined && !isValidPresetName(input.name)) {
    return refuse('preset_name_invalid', {
      detail: `${String(EFFECT_NAME_MIN_LENGTH)}..${String(EFFECT_NAME_MAX_LENGTH)} characters`,
    });
  }

  if (input.chain !== undefined) {
    const violations = chainViolations(input.chain);
    if (violations.length > 0) {
      return refuse('preset_chain_invalid', { chainViolations: violations });
    }
  }

  const updated: EffectPreset = {
    ...existing,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.chain === undefined ? {} : { chain: toChain(input.chain) }),
  };

  return {
    ok: true,
    presets: input.presets.map((preset) => (preset.id === input.presetId ? updated : preset)),
    preset: updated,
  };
}

/** Requirement 29.23: delete a user preset; refuse for a built-in. */
export function deletePreset(
  ownerId: string,
  presets: readonly EffectPreset[],
  presetId: string,
): PresetOutcome {
  if (isBuiltInPresetId(presetId)) {
    return refuse('builtin_preset_immutable', { presetId });
  }

  const existing = presets.find((preset) => preset.id === presetId);
  if (existing === undefined) return refuse('preset_not_found', { presetId });
  if (existing.ownerId !== ownerId) return refuse('preset_not_owned', { presetId });

  return {
    ok: true,
    presets: presets.filter((preset) => preset.id !== presetId),
    removed: existing,
  };
}
