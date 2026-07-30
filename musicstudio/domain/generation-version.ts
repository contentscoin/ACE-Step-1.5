/**
 * Generation_Version model (design §4.1).
 *
 * Structural constraints only: exactly one default and one original version per
 * asset. Effect-chain semantics, the 16-version cap and default promotion are
 * Effects_Service behaviour (Requirement 29, task 3.2).
 */

export const VERSION_NAME_MIN_LENGTH = 1;
export const VERSION_NAME_MAX_LENGTH = 200;

/** Versions kept per asset (Req 29). Enforced by Effects_Service in task 3.2. */
export const MAX_VERSIONS_PER_ASSET = 16;

export interface GenerationVersion {
  readonly id: string;
  readonly assetId: string;
  readonly name: string;
  /** Serialised Effect_Chain; parsed by the Chain_Parser in task 3.2. */
  readonly effectChain: unknown;
  readonly derivedFromVersionId: string | null;
  readonly isDefault: boolean;
  readonly isOriginal: boolean;
  readonly durationMs: number;
  readonly createdAtMs: number;
}

export type GenerationVersionSetViolation =
  | 'no_default_version'
  | 'multiple_default_versions'
  | 'no_original_version'
  | 'multiple_original_versions'
  | 'version_count_exceeded'
  | 'foreign_asset_version';

/**
 * Check the version set of one asset. Mirrors the two unique partial indexes in
 * `db/migrations/0004_generation_version.sql`.
 */
export function validateVersionSet(
  assetId: string,
  versions: readonly GenerationVersion[],
): GenerationVersionSetViolation[] {
  const violations: GenerationVersionSetViolation[] = [];

  if (versions.some((version) => version.assetId !== assetId)) {
    violations.push('foreign_asset_version');
  }
  if (versions.length > MAX_VERSIONS_PER_ASSET) violations.push('version_count_exceeded');

  const defaults = versions.filter((version) => version.isDefault).length;
  if (defaults === 0) violations.push('no_default_version');
  if (defaults > 1) violations.push('multiple_default_versions');

  const originals = versions.filter((version) => version.isOriginal).length;
  if (originals === 0) violations.push('no_original_version');
  if (originals > 1) violations.push('multiple_original_versions');

  return violations;
}
