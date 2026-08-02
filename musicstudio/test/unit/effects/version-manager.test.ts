import { describe, expect, it } from 'vitest';

import { toChain } from '../../../domain/effects/chain';
import { MAX_VERSIONS_PER_ASSET } from '../../../domain/effects/registry';
import {
  validateVersionSet,
  type GenerationVersion,
} from '../../../domain/generation-version';
import {
  createDerivedVersion,
  defaultVersion,
  deleteVersion,
  originalVersion,
  pickPromotionTarget,
  promoteToDefault,
  remainingVersionSlots,
} from '../../../services/effects/version-manager';

/**
 * `Generation_Version` management.
 *
 * **Validates: Requirements 29.14, 29.15, 29.16, 29.17, 29.18, 29.19, 29.20, 29.34**
 *
 * Four of these clauses are stated as *invariants* ("불변식"): exactly one original (29.15),
 * exactly one default (29.16), at most 16 versions (29.19), and nothing existing altered by a
 * new version (29.14). An invariant is a statement about a set, so every assertion below is
 * made against the whole returned set rather than against the one row an operation touched —
 * and each successful outcome is additionally run through `validateVersionSet`, which is the
 * same check migration `0004`'s unique partial indexes make in SQL.
 */

const ASSET = 'asset-1';
const CHAIN = toChain([{ kind: 'gain', parameters: { gain_db: -3 } }]);

function version(overrides: Partial<GenerationVersion> & { id: string }): GenerationVersion {
  return {
    assetId: ASSET,
    name: 'v',
    effectChain: [],
    derivedFromVersionId: null,
    isDefault: false,
    isOriginal: false,
    durationMs: 1000,
    createdAtMs: 1000,
    ...overrides,
  };
}

/** The starting point every asset has: one original, which is also the default. */
function initialSet(): GenerationVersion[] {
  return [version({ id: 'v-original', name: 'Original', isOriginal: true, isDefault: true })];
}

function expectSetLegal(versions: readonly GenerationVersion[]): void {
  expect(validateVersionSet(ASSET, versions)).toEqual([]);
}

describe('Requirement 29.14 — applying a chain adds one version and changes nothing', () => {
  it('appends exactly one version', () => {
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: initialSet(),
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-2',
      name: 'Brighter',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.versions).toHaveLength(2);
    expect(outcome.created?.id).toBe('v-2');
    expectSetLegal(outcome.versions);
  });

  it('records the input version as the derived-from version', () => {
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: initialSet(),
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-2',
      name: 'Brighter',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.created?.derivedFromVersionId).toBe('v-original');
  });

  it('leaves the existing default designation untouched', () => {
    // The clause is explicit: "기존 기본 버전 지정을 변경하지 않는다". A user auditioning
    // an effect must not silently lose the version they were happy with.
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: initialSet(),
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-2',
      name: 'Brighter',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(defaultVersion(outcome.versions)?.id).toBe('v-original');
    expect(outcome.created?.isDefault).toBe(false);
  });

  it('does not rewrite any existing version object', () => {
    // Requirement 29.15's "그 오디오 데이터를 수정하거나 대체하지 않는다" at the level this
    // module can check: the surviving elements are the *same references*, so there is no
    // code path that could have edited one.
    const before = initialSet();
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: before,
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-2',
      name: 'Brighter',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.versions[0]).toBe(before[0]);
    expect(before).toHaveLength(1);
  });

  it('stores the chain as the printed document', () => {
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: initialSet(),
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-2',
      name: 'Brighter',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.created?.effectChain).toEqual([
      { kind: 'gain', parameters: { gain_db: -3 } },
    ]);
  });

  it('refuses a derived-from version that does not exist', () => {
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: initialSet(),
      derivedFromVersionId: 'v-missing',
      newVersionId: 'v-2',
      name: 'Brighter',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('version_not_found');
  });
});

describe('Requirement 29.20 — the version name is 1–60 characters', () => {
  function attempt(name: string) {
    return createDerivedVersion({
      assetId: ASSET,
      versions: initialSet(),
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-2',
      name,
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 2000,
    });
  }

  it('accepts one character and sixty', () => {
    expect(attempt('a').ok).toBe(true);
    expect(attempt('a'.repeat(60)).ok).toBe(true);
  });

  it('refuses an empty name and sixty-one characters', () => {
    // 60, not the 200 that `generation_version.name`'s column allows. See the note in
    // version-manager.ts: 0004 is the storage bound, 29.20 is what a user may send.
    expect(attempt('').ok).toBe(false);
    expect(attempt('a'.repeat(61)).ok).toBe(false);
  });
});

describe('Requirement 29.19 — at most 16 versions per asset', () => {
  function fullSet(): GenerationVersion[] {
    return [
      version({ id: 'v-original', isOriginal: true, isDefault: true }),
      ...Array.from({ length: MAX_VERSIONS_PER_ASSET - 1 }, (_unused, index) =>
        version({ id: `v-${String(index + 2)}`, createdAtMs: 2000 + index }),
      ),
    ];
  }

  it('accepts the sixteenth version', () => {
    const fifteen = fullSet().slice(0, 15);
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: fifteen,
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-16',
      name: 'Sixteenth',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 9000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.versions).toHaveLength(16);
  });

  it('refuses the seventeenth and returns the count and the limit', () => {
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: fullSet(),
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-17',
      name: 'Seventeenth',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 9000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('version_limit_reached');
      expect(outcome.currentCount).toBe(16);
      expect(outcome.limit).toBe(16);
    }
  });

  it('leaves the version list and the default designation untouched on refusal', () => {
    // The clause requires exactly this. Nothing here mutates, so the refusal path
    // cannot have changed anything — but the assertion pins the guarantee.
    const before = fullSet();
    const snapshot = [...before];
    const outcome = createDerivedVersion({
      assetId: ASSET,
      versions: before,
      derivedFromVersionId: 'v-original',
      newVersionId: 'v-17',
      name: 'Seventeenth',
      chain: CHAIN,
      durationMs: 1000,
      createdAtMs: 9000,
    });
    expect(outcome.ok).toBe(false);
    expect(before).toEqual(snapshot);
    expect(defaultVersion(before)?.id).toBe('v-original');
  });

  it('reports the remaining slots', () => {
    expect(remainingVersionSlots(initialSet())).toBe(15);
    expect(remainingVersionSlots(fullSet())).toBe(0);
  });
});

describe('Requirement 29.34 — setting the default version', () => {
  it('sets the target true and every other version false', () => {
    const versions = [
      version({ id: 'v-original', isOriginal: true, isDefault: true }),
      version({ id: 'v-2' }),
      version({ id: 'v-3' }),
    ];
    const outcome = promoteToDefault(ASSET, versions, 'v-3');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.versions.filter((v) => v.isDefault).map((v) => v.id)).toEqual(['v-3']);
    expectSetLegal(outcome.versions);
  });

  it('is idempotent for a version that is already the default', () => {
    const versions = initialSet();
    const outcome = promoteToDefault(ASSET, versions, 'v-original');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.versions.filter((v) => v.isDefault)).toHaveLength(1);
  });

  it('refuses an unknown version', () => {
    const outcome = promoteToDefault(ASSET, initialSet(), 'v-missing');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('version_not_found');
  });

  it('can promote the original back to default', () => {
    const versions = [
      version({ id: 'v-original', isOriginal: true }),
      version({ id: 'v-2', isDefault: true }),
    ];
    const outcome = promoteToDefault(ASSET, versions, 'v-original');
    if (!outcome.ok) throw new Error('expected success');
    expect(defaultVersion(outcome.versions)?.id).toBe('v-original');
  });
});

describe('Requirement 29.18 — the original version is never deletable', () => {
  it('refuses deletion of the original with the preservation reason', () => {
    const outcome = deleteVersion(ASSET, initialSet(), 'v-original');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('original_version_preserved');
      expect(outcome.versionId).toBe('v-original');
    }
  });

  it('refuses even when the original is not the default', () => {
    // Checked before anything else, unconditionally: an original that is also the
    // default must be refused as an original rather than promoted around.
    const versions = [
      version({ id: 'v-original', isOriginal: true }),
      version({ id: 'v-2', isDefault: true }),
    ];
    const outcome = deleteVersion(ASSET, versions, 'v-original');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('original_version_preserved');
  });
});

describe('Requirement 29.17 — promotion when the default is deleted', () => {
  it('promotes the survivor with the latest creation time', () => {
    const versions = [
      version({ id: 'v-original', isOriginal: true, createdAtMs: 1000 }),
      version({ id: 'v-2', createdAtMs: 2000 }),
      version({ id: 'v-3', createdAtMs: 5000 }),
      version({ id: 'v-4', isDefault: true, createdAtMs: 3000 }),
    ];
    const outcome = deleteVersion(ASSET, versions, 'v-4');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.promoted?.id).toBe('v-3');
    expect(defaultVersion(outcome.versions)?.id).toBe('v-3');
    expectSetLegal(outcome.versions);
  });

  it('breaks a creation-time tie by ascending version id', () => {
    // Millisecond timestamps collide readily when a batch writes several versions.
    // Without the tie-break two replicas replaying the same deletion could promote
    // different versions and disagree about the asset's default for ever.
    const versions = [
      version({ id: 'v-original', isOriginal: true, createdAtMs: 1000 }),
      version({ id: 'v-zeta', createdAtMs: 7000 }),
      version({ id: 'v-alpha', createdAtMs: 7000 }),
      version({ id: 'v-default', isDefault: true, createdAtMs: 3000 }),
    ];
    const outcome = deleteVersion(ASSET, versions, 'v-default');
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.promoted?.id).toBe('v-alpha');
  });

  it('promotes the original when it is the only survivor', () => {
    const versions = [
      version({ id: 'v-original', isOriginal: true, createdAtMs: 1000 }),
      version({ id: 'v-2', isDefault: true, createdAtMs: 2000 }),
    ];
    const outcome = deleteVersion(ASSET, versions, 'v-2');
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.versions).toHaveLength(1);
    expect(defaultVersion(outcome.versions)?.id).toBe('v-original');
  });

  it('does not change the default when a non-default version is deleted', () => {
    const versions = [
      version({ id: 'v-original', isOriginal: true, isDefault: true, createdAtMs: 1000 }),
      version({ id: 'v-2', createdAtMs: 2000 }),
      version({ id: 'v-3', createdAtMs: 3000 }),
    ];
    const outcome = deleteVersion(ASSET, versions, 'v-2');
    if (!outcome.ok) throw new Error('expected success');
    expect(defaultVersion(outcome.versions)?.id).toBe('v-original');
    expect(outcome.promoted).toBeUndefined();
    expect(outcome.removed?.id).toBe('v-2');
  });

  it('refuses an unknown version', () => {
    const outcome = deleteVersion(ASSET, initialSet(), 'v-missing');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('version_not_found');
  });
});

describe('pickPromotionTarget', () => {
  it('returns undefined for an empty set', () => {
    expect(pickPromotionTarget([])).toBeUndefined();
  });

  it('is independent of input order', () => {
    const a = version({ id: 'b', createdAtMs: 5 });
    const b = version({ id: 'a', createdAtMs: 5 });
    expect(pickPromotionTarget([a, b])?.id).toBe('a');
    expect(pickPromotionTarget([b, a])?.id).toBe('a');
  });
});

describe('Requirements 29.15, 29.16 — the set-level invariants', () => {
  it('refuses to operate on a set that already violates them', () => {
    // A caller holding a two-default set would otherwise get a "successful" result that
    // still had two defaults, and the breach would be blamed on the next operation.
    const broken = [
      version({ id: 'v-original', isOriginal: true, isDefault: true }),
      version({ id: 'v-2', isDefault: true }),
    ];
    const outcome = promoteToDefault(ASSET, broken, 'v-2');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('version_set_invalid');
      expect(outcome.detail).toContain('multiple_default_versions');
    }
  });

  it('refuses a set containing a version from another asset', () => {
    const foreign = [
      version({ id: 'v-original', isOriginal: true, isDefault: true }),
      version({ id: 'v-x', assetId: 'other-asset' }),
    ];
    const outcome = deleteVersion(ASSET, foreign, 'v-x');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('version_set_invalid');
  });

  it('exposes the preserved original', () => {
    expect(originalVersion(initialSet())?.id).toBe('v-original');
  });
});
