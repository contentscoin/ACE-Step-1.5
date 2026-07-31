/**
 * `Generation_Version` management (Requirements 29.14–29.20, 29.34).
 *
 * Pure functions over a version *set*: each takes the current versions of one asset and
 * returns either the new set or a refusal. No storage, no clock reads, no identifier
 * generation — those arrive as arguments. That shape is what makes the four invariants
 * of Requirement 29 checkable at all, because an invariant is a statement about a set
 * and a function that returns the whole new set can be asserted against it directly.
 *
 * ### The four invariants this module maintains
 *
 * | clause | invariant |
 * |--------|-----------|
 * | 29.15  | exactly one original version per asset, its audio never modified |
 * | 29.16  | exactly one default version per asset, always |
 * | 29.19  | at most 16 versions per asset, original included |
 * | 29.14  | applying a chain adds one version and changes no existing one |
 *
 * `domain/generation-version.ts` already states the two structural ones (29.15, 29.16)
 * as `validateVersionSet`, and mirrors them as unique partial indexes in migration
 * `0004`. This module **extends** that rather than restating it: every operation below
 * runs its result through `validateVersionSet` before returning it, so an operation that
 * broke an invariant would be caught here rather than by the database. That check is not
 * belt-and-braces — it is the only place the count cap of 29.19 and the promotion rule of
 * 29.17 meet the uniqueness rules, and they interact (deleting the default reduces the
 * count *and* requires a promotion).
 *
 * ### Why refusals are returned, not thrown
 *
 * Requirements 29.18, 29.19 and 29.34 all specify a *payload* on refusal — a reason code,
 * the current count and the cap, the offending identifier. An exception carrying a
 * formatted string would force the API layer to parse its own error message to build a
 * response body. So every operation returns a discriminated union and the caller narrows.
 *
 * Requirement 29.19 additionally demands that a refused creation leave "기존 버전 목록과
 * 기본 버전 지정" untouched. Returning a fresh array on success and *nothing* on failure
 * makes that structural: there is no code path on which a refusal has mutated anything,
 * because nothing here mutates at all.
 */

import {
  MAX_VERSIONS_PER_ASSET,
  validateVersionSet,
  type GenerationVersion,
} from '../../domain/generation-version';
import {
  EFFECT_NAME_MAX_LENGTH,
  EFFECT_NAME_MIN_LENGTH,
  type EffectChain,
} from '../../domain/effects';
import { chainToDocument } from '../../domain/effects/chain-printer';

export type VersionRefusalCode =
  /** Requirement 29.19: the asset already holds 16 versions. */
  | 'version_limit_reached'
  /** Requirement 29.18: the original version is never deletable. */
  | 'original_version_preserved'
  /** 29.14/29.34: the named version does not belong to this asset. */
  | 'version_not_found'
  /** Requirement 29.20: the name is outside 1–60 characters. */
  | 'version_name_invalid'
  /** The set handed in already violated 29.15/29.16 before this operation. */
  | 'version_set_invalid';

export interface VersionRefusal {
  readonly ok: false;
  readonly code: VersionRefusalCode;
  /** Requirement 29.19: the count and the cap travel with the refusal. */
  readonly currentCount?: number;
  readonly limit?: number;
  readonly versionId?: string;
  readonly detail?: string;
}

export interface VersionSetChange {
  readonly ok: true;
  /** The complete new version set for the asset. */
  readonly versions: readonly GenerationVersion[];
  /** The version this operation created, when it created one. */
  readonly created?: GenerationVersion;
  /** The version promoted to default by Requirement 29.17, when one was. */
  readonly promoted?: GenerationVersion;
  /** The version removed, when one was. */
  readonly removed?: GenerationVersion;
}

export type VersionOutcome = VersionSetChange | VersionRefusal;

function refuse(code: VersionRefusalCode, rest: Partial<VersionRefusal> = {}): VersionRefusal {
  return { ok: false, code, ...rest };
}

/**
 * Guard every operation shares: the incoming set must already be legal.
 *
 * Without this, a caller holding a set with two defaults would get a "successful"
 * result that still had two defaults, and the invariant breach would be attributed to
 * whichever operation ran next.
 */
function requireValidSet(
  assetId: string,
  versions: readonly GenerationVersion[],
): VersionRefusal | null {
  const violations = validateVersionSet(assetId, versions);
  if (violations.length === 0) return null;
  return refuse('version_set_invalid', { detail: violations.join(',') });
}

function isValidVersionName(name: string): boolean {
  return name.length >= EFFECT_NAME_MIN_LENGTH && name.length <= EFFECT_NAME_MAX_LENGTH;
}

/**
 * Requirement 29.20's name bound is 1–60; `domain/generation-version.ts` says 1–200.
 *
 * The narrower bound wins, and this is the reason it is applied here rather than there.
 * `VERSION_NAME_MAX_LENGTH` in the domain model is the *storage* bound, mirrored by the
 * `CHECK` in migration `0004` which was written for task 1.1 before Requirement 29 was
 * implemented. Requirement 29.20 is specifically about the name a user gives a version
 * through `Effects_Service`, so `Effects_Service` enforces 60. Relaxing the column to 60
 * would be the tidier outcome but would invalidate any row already written at up to 200
 * characters, so the column stays permissive and this is the gate. Noted in the report as
 * a spec inconsistency rather than resolved silently.
 */
export const VERSION_NAME_MAX_LENGTH_EFFECTS = EFFECT_NAME_MAX_LENGTH;

export interface CreateVersionInput {
  readonly assetId: string;
  readonly versions: readonly GenerationVersion[];
  /** Requirement 29.14: the version the chain was applied to. */
  readonly derivedFromVersionId: string;
  readonly newVersionId: string;
  readonly name: string;
  readonly chain: EffectChain;
  readonly durationMs: number;
  readonly createdAtMs: number;
}

/**
 * Requirement 29.14: add one derived version, changing nothing that exists.
 *
 * Every clause of 29.14 is visible in the return value:
 *
 * - *"새 Generation_Version 1개를 생성"* — exactly one element is appended.
 * - *"입력 버전 식별자를 파생 원본 버전 식별자로 기록"* — `derivedFromVersionId` is
 *   copied onto the new row.
 * - *"입력 버전의 오디오 데이터와 원본 오디오 파일을 변경하지 않고"* — no existing
 *   element is rewritten. The existing versions are spread through untouched, so the
 *   objects in the returned array are the *same references*; there is no code path that
 *   could edit one.
 * - *"기존 기본 버전 지정을 변경하지 않는다"* — `isDefault` is `false` on the new
 *   version and no existing flag is touched. Promotion is a separate, explicit act
 *   (Requirement 29.34), which is the point: a user auditioning an effect does not
 *   silently lose the version they were happy with.
 *
 * Requirement 29.19's cap is checked before anything is built, and the refusal carries
 * the count and the limit.
 */
export function createDerivedVersion(input: CreateVersionInput): VersionOutcome {
  const invalid = requireValidSet(input.assetId, input.versions);
  if (invalid !== null) return invalid;

  if (!isValidVersionName(input.name)) {
    return refuse('version_name_invalid', {
      detail: `${String(EFFECT_NAME_MIN_LENGTH)}..${String(EFFECT_NAME_MAX_LENGTH)} characters`,
    });
  }

  // Requirement 29.19. The comparison is `>=` because this call is about to add one:
  // a set already at 16 cannot grow, and the clause names 16 as the state in which
  // creation is refused.
  if (input.versions.length >= MAX_VERSIONS_PER_ASSET) {
    return refuse('version_limit_reached', {
      currentCount: input.versions.length,
      limit: MAX_VERSIONS_PER_ASSET,
    });
  }

  const parent = input.versions.find((version) => version.id === input.derivedFromVersionId);
  if (parent === undefined) {
    return refuse('version_not_found', { versionId: input.derivedFromVersionId });
  }

  const created: GenerationVersion = {
    id: input.newVersionId,
    assetId: input.assetId,
    name: input.name,
    // Stored as the printed document rather than the domain object, because the column
    // is `jsonb` (migration 0004) and `chainToDocument` is the one canonical rendering.
    effectChain: chainToDocument(input.chain),
    derivedFromVersionId: parent.id,
    isDefault: false,
    isOriginal: false,
    durationMs: input.durationMs,
    createdAtMs: input.createdAtMs,
  };

  const versions = [...input.versions, created];
  const broken = requireValidSet(input.assetId, versions);
  if (broken !== null) return broken;

  return { ok: true, versions, created };
}

/**
 * Requirement 29.34: make one version the default, and no other.
 *
 * Written as a full rewrite of every version's `isDefault` rather than as "clear the old
 * one, set the new one". The clause is stated that way — set this one true and *all
 * others* false — and expressing it literally means the result satisfies 29.16 by
 * construction for any input, including a set that arrived with the flag missing
 * entirely. A two-step version would have an intermediate state with zero defaults,
 * which is exactly the window a partial failure would leave behind.
 */
export function promoteToDefault(
  assetId: string,
  versions: readonly GenerationVersion[],
  versionId: string,
): VersionOutcome {
  const invalid = requireValidSet(assetId, versions);
  if (invalid !== null) return invalid;

  const target = versions.find((version) => version.id === versionId);
  if (target === undefined) return refuse('version_not_found', { versionId });

  const next = versions.map((version) => ({ ...version, isDefault: version.id === versionId }));
  const promoted = next.find((version) => version.id === versionId);

  const broken = requireValidSet(assetId, next);
  if (broken !== null) return broken;

  return { ok: true, versions: next, ...(promoted === undefined ? {} : { promoted }) };
}

/**
 * Requirements 29.17, 29.18: delete a version, promoting a successor if it was default.
 *
 * 29.18 first: the original is never deletable, and the refusal names the reason code.
 * That check precedes everything else because it is unconditional — an original that
 * happened to also be the default must be refused as an original, not promoted around.
 *
 * Then 29.17's promotion rule, which is fully specified and so is implemented exactly:
 * the **latest `createdAtMs`** among the survivors wins, and on a tie the **lowest
 * version id in ascending order** wins. The tie-break is not decoration — millisecond
 * timestamps collide readily when two versions are written by one batch, and without it
 * two replicas replaying the same deletion could promote different versions and disagree
 * about the asset's default for ever. String comparison is used for the id, which is what
 * "버전 식별자 오름차순" means for the UUID-shaped ids of migration `0004`.
 */
export function deleteVersion(
  assetId: string,
  versions: readonly GenerationVersion[],
  versionId: string,
): VersionOutcome {
  const invalid = requireValidSet(assetId, versions);
  if (invalid !== null) return invalid;

  const target = versions.find((version) => version.id === versionId);
  if (target === undefined) return refuse('version_not_found', { versionId });

  // Requirement 29.18.
  if (target.isOriginal) return refuse('original_version_preserved', { versionId });

  const survivors = versions.filter((version) => version.id !== versionId);

  // A non-original version was removed, so at least the original survives and
  // `survivors` is never empty. Requirement 29.15 is what guarantees that.
  if (!target.isDefault) {
    const broken = requireValidSet(assetId, survivors);
    if (broken !== null) return broken;
    return { ok: true, versions: survivors, removed: target };
  }

  // Requirement 29.17: promote the newest survivor, ties broken by ascending id.
  const heir = pickPromotionTarget(survivors);
  if (heir === undefined) return refuse('version_set_invalid', { detail: 'no_surviving_version' });

  const next = survivors.map((version) => ({ ...version, isDefault: version.id === heir.id }));
  const promoted = next.find((version) => version.id === heir.id);

  const broken = requireValidSet(assetId, next);
  if (broken !== null) return broken;

  return {
    ok: true,
    versions: next,
    removed: target,
    ...(promoted === undefined ? {} : { promoted }),
  };
}

/**
 * Requirement 29.17's choice function: latest `createdAtMs`, then lowest id.
 *
 * Exported because it is the rule itself, and the property suite asserts it directly
 * over generated sets rather than only through `deleteVersion`.
 */
export function pickPromotionTarget(
  versions: readonly GenerationVersion[],
): GenerationVersion | undefined {
  let best: GenerationVersion | undefined;
  for (const candidate of versions) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    if (candidate.createdAtMs > best.createdAtMs) {
      best = candidate;
      continue;
    }
    if (candidate.createdAtMs === best.createdAtMs && candidate.id < best.id) {
      best = candidate;
    }
  }
  return best;
}

/** Requirement 29.15: the preserved original, if the set is well formed. */
export function originalVersion(
  versions: readonly GenerationVersion[],
): GenerationVersion | undefined {
  return versions.find((version) => version.isOriginal);
}

export function defaultVersion(
  versions: readonly GenerationVersion[],
): GenerationVersion | undefined {
  return versions.find((version) => version.isDefault);
}

/** Requirement 29.19: how many more versions this asset can hold. */
export function remainingVersionSlots(versions: readonly GenerationVersion[]): number {
  return Math.max(0, MAX_VERSIONS_PER_ASSET - versions.length);
}
