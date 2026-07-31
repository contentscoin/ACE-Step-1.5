import { describe, expect, it } from 'vitest';

import { chainViolations } from '../../../domain/effects/chain';
import {
  BUILT_IN_PRESETS,
  findBuiltInPreset,
  isBuiltInPreset,
  isBuiltInPresetId,
  isValidPresetName,
  type EffectPreset,
} from '../../../domain/effects/preset';
import { MAX_PRESETS_PER_USER } from '../../../domain/effects/registry';
import {
  createPreset,
  deletePreset,
  listPresets,
  ownedPresetCount,
  updatePreset,
} from '../../../services/effects/preset-service';

/**
 * `Effect_Preset` — the built-in set and user CRUD.
 *
 * **Validates: Requirements 29.21, 29.22, 29.23, 29.35**
 *
 * The clause that most needs testing is 29.35, because it is easy to satisfy incorrectly: the
 * cap is "사용자당", so counting the four ownerless built-ins against it would silently cost
 * every user four slots. That distinction is asserted directly below rather than left to
 * follow from the implementation.
 */

const OWNER = 'account-1';
const CHAIN = [{ kind: 'gain', parameters: { gain_db: -3 } }];

function preset(overrides: Partial<EffectPreset> & { id: string }): EffectPreset {
  return {
    ownerId: OWNER,
    name: `preset-${overrides.id}`,
    chain: { items: [{ kind: 'gain', parameters: { gain_db: 0 } }] },
    createdAtMs: 1000,
    ...overrides,
  };
}

describe('Requirement 29.21 — at least four built-in presets', () => {
  it('provides four or more', () => {
    expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every built-in a valid chain inside Requirements 29.2–29.8\u2019s ranges', () => {
    // The built-ins are literal parameter values, so nothing but this assertion stops a
    // future edit reaching for a "nicer" reverb outside [0, 1].
    for (const builtIn of BUILT_IN_PRESETS) {
      expect(chainViolations(builtIn.chain.items), builtIn.id).toEqual([]);
    }
  });

  it('gives every built-in a valid name and a stable id', () => {
    for (const builtIn of BUILT_IN_PRESETS) {
      expect(isValidPresetName(builtIn.name)).toBe(true);
      expect(builtIn.id.startsWith('builtin_')).toBe(true);
    }
  });

  it('marks them ownerless, which is what makes them built-in', () => {
    for (const builtIn of BUILT_IN_PRESETS) {
      expect(builtIn.ownerId).toBeNull();
      expect(isBuiltInPreset(builtIn)).toBe(true);
    }
  });

  it('uses distinct ids and names', () => {
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.id)).size).toBe(BUILT_IN_PRESETS.length);
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.name)).size).toBe(BUILT_IN_PRESETS.length);
  });

  it('gives them a fixed creation time rather than the process start time', () => {
    // A value that changed per process would make the same preset sort differently
    // between two servers.
    for (const builtIn of BUILT_IN_PRESETS) expect(builtIn.createdAtMs).toBe(0);
  });

  it('offers built-ins plus the user\u2019s own, built-ins first', () => {
    const owned = [preset({ id: 'p-1' })];
    const listed = listPresets(owned);
    expect(listed).toHaveLength(BUILT_IN_PRESETS.length + 1);
    expect(listed[0]?.id).toBe(BUILT_IN_PRESETS[0]?.id);
    expect(listed.at(-1)?.id).toBe('p-1');
  });

  it('finds a built-in by id', () => {
    expect(findBuiltInPreset('builtin_vocal_space')?.name).toBe('Vocal Space');
    expect(findBuiltInPreset('nope')).toBeUndefined();
    expect(isBuiltInPresetId('builtin_tape_slap')).toBe(true);
    expect(isBuiltInPresetId('p-1')).toBe(false);
  });
});

describe('Requirement 29.22 — creating a user preset', () => {
  it('stores the chain as a preset owned by the requester', () => {
    const outcome = createPreset({
      ownerId: OWNER,
      presets: [],
      presetId: 'p-1',
      name: 'My Chain',
      chain: CHAIN,
      createdAtMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preset?.ownerId).toBe(OWNER);
    expect(outcome.preset?.name).toBe('My Chain');
    expect(outcome.presets).toHaveLength(1);
  });

  it('accepts a one-character name and a sixty-character name', () => {
    for (const name of ['a', 'a'.repeat(60)]) {
      const outcome = createPreset({
        ownerId: OWNER,
        presets: [],
        presetId: 'p-1',
        name,
        chain: CHAIN,
        createdAtMs: 5000,
      });
      expect(outcome.ok, name).toBe(true);
    }
  });

  it('refuses an empty name and a sixty-one character name', () => {
    for (const name of ['', 'a'.repeat(61)]) {
      const outcome = createPreset({
        ownerId: OWNER,
        presets: [],
        presetId: 'p-1',
        name,
        chain: CHAIN,
        createdAtMs: 5000,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('preset_name_invalid');
    }
  });

  it('refuses a chain with an out-of-range parameter, reporting the violations', () => {
    // A preset must not become the way an out-of-range parameter enters the system.
    const outcome = createPreset({
      ownerId: OWNER,
      presets: [],
      presetId: 'p-1',
      name: 'Bad',
      chain: [{ kind: 'gain', parameters: { gain_db: 99 } }],
      createdAtMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('preset_chain_invalid');
      expect(outcome.chainViolations?.[0]?.violation).toBe('parameter_out_of_range');
    }
  });

  it('refuses an empty chain and a seventeen-item chain (Requirement 29.13)', () => {
    for (const chain of [[], Array.from({ length: 17 }, () => CHAIN[0])]) {
      const outcome = createPreset({
        ownerId: OWNER,
        presets: [],
        presetId: 'p-1',
        name: 'Bad',
        chain,
        createdAtMs: 5000,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('preset_chain_invalid');
    }
  });
});

describe('Requirement 29.35 — 100 presets per user', () => {
  function owned(count: number): EffectPreset[] {
    return Array.from({ length: count }, (_unused, index) =>
      preset({ id: `p-${String(index)}` }),
    );
  }

  it('accepts the hundredth preset', () => {
    const outcome = createPreset({
      ownerId: OWNER,
      presets: owned(99),
      presetId: 'p-100',
      name: 'Hundredth',
      chain: CHAIN,
      createdAtMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.presets).toHaveLength(100);
  });

  it('refuses the hundred-and-first and returns the count and the limit', () => {
    const outcome = createPreset({
      ownerId: OWNER,
      presets: owned(MAX_PRESETS_PER_USER),
      presetId: 'p-101',
      name: 'Too many',
      chain: CHAIN,
      createdAtMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('preset_limit_reached');
      expect(outcome.currentCount).toBe(100);
      expect(outcome.limit).toBe(100);
    }
  });

  it('does not count the built-ins against the cap', () => {
    // The four built-ins are ownerless and visible to everyone; counting them would
    // silently cost every user four slots.
    expect(ownedPresetCount(OWNER, listPresets(owned(3)))).toBe(3);
  });

  it('does not count another user\u2019s presets against the cap', () => {
    const mixed = [...owned(2), preset({ id: 'other', ownerId: 'account-2' })];
    expect(ownedPresetCount(OWNER, mixed)).toBe(2);
  });
});

describe('Requirement 29.23 — built-in presets are immutable', () => {
  it('refuses an update to a built-in with the immutability reason', () => {
    const outcome = updatePreset({
      ownerId: OWNER,
      presets: [],
      presetId: 'builtin_vocal_space',
      name: 'Hijacked',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Not `preset_not_found`: a client cannot distinguish "does not exist" from
      // "may not be changed" without the specific reason the clause asks for.
      expect(outcome.code).toBe('builtin_preset_immutable');
      expect(outcome.presetId).toBe('builtin_vocal_space');
    }
  });

  it('refuses a delete of a built-in', () => {
    const outcome = deletePreset(OWNER, [], 'builtin_tape_slap');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('builtin_preset_immutable');
  });

  it('leaves the built-in\u2019s name and chain unchanged', () => {
    const before = BUILT_IN_PRESETS.map((p) => ({ name: p.name, items: p.chain.items }));
    updatePreset({
      ownerId: OWNER,
      presets: [],
      presetId: 'builtin_wide_chorus',
      name: 'Hijacked',
      chain: CHAIN,
    });
    deletePreset(OWNER, [], 'builtin_wide_chorus');
    expect(BUILT_IN_PRESETS.map((p) => ({ name: p.name, items: p.chain.items }))).toEqual(before);
  });
});

describe('user preset update and delete', () => {
  it('renames a preset', () => {
    const outcome = updatePreset({
      ownerId: OWNER,
      presets: [preset({ id: 'p-1' })],
      presetId: 'p-1',
      name: 'Renamed',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.preset?.name).toBe('Renamed');
  });

  it('replaces a chain', () => {
    const outcome = updatePreset({
      ownerId: OWNER,
      presets: [preset({ id: 'p-1' })],
      presetId: 'p-1',
      chain: [{ kind: 'pitch_shift', parameters: { semitones: 5 } }],
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.preset?.chain.items[0]?.kind).toBe('pitch_shift');
  });

  it('refuses an update to another user\u2019s preset', () => {
    const outcome = updatePreset({
      ownerId: OWNER,
      presets: [preset({ id: 'p-1', ownerId: 'account-2' })],
      presetId: 'p-1',
      name: 'Mine now',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('preset_not_owned');
  });

  it('refuses an update with an invalid chain, leaving the preset alone', () => {
    const presets = [preset({ id: 'p-1' })];
    const outcome = updatePreset({
      ownerId: OWNER,
      presets,
      presetId: 'p-1',
      chain: [{ kind: 'gain', parameters: { gain_db: 99 } }],
    });
    expect(outcome.ok).toBe(false);
    expect(presets[0]?.chain.items[0]?.parameters.gain_db).toBe(0);
  });

  it('deletes a user preset', () => {
    const outcome = deletePreset(OWNER, [preset({ id: 'p-1' }), preset({ id: 'p-2' })], 'p-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.presets.map((p) => p.id)).toEqual(['p-2']);
    expect(outcome.removed?.id).toBe('p-1');
  });

  it('refuses to delete an unknown or unowned preset', () => {
    const missing = deletePreset(OWNER, [], 'p-1');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('preset_not_found');

    const foreign = deletePreset(OWNER, [preset({ id: 'p-1', ownerId: 'account-2' })], 'p-1');
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe('preset_not_owned');
  });
});
