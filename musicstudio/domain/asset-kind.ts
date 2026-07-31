/**
 * Asset_Kind — the single classification every Audio_Asset carries.
 *
 * Requirements 19.1 (exactly one kind per asset), 19.9 (reject unknown kinds and
 * return the allowed list), 19.10 (loop flag applies to `bgm`/`sfx`),
 * 19.7 (`stem`/`mix` require at least one input asset). Design §4.1.
 */

export const ASSET_KINDS = ['song', 'bgm', 'sfx', 'dialogue', 'stem', 'mix'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** Kinds for which a loop flag is meaningful (Req 19.10). */
export const LOOPABLE_ASSET_KINDS: readonly AssetKind[] = ['bgm', 'sfx'];

/** Kinds that may never exist without at least one input asset (Req 19.7). */
export const LINEAGE_REQUIRED_ASSET_KINDS: readonly AssetKind[] = ['stem', 'mix'];

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

export function isLoopableAssetKind(kind: AssetKind): boolean {
  return LOOPABLE_ASSET_KINDS.includes(kind);
}

export function requiresLineage(kind: AssetKind): boolean {
  return LINEAGE_REQUIRED_ASSET_KINDS.includes(kind);
}

/** Rejection payload for Req 19.9: the caller is told which kinds are allowed. */
export interface UnknownAssetKind {
  readonly received: unknown;
  readonly allowed: readonly AssetKind[];
}

export function describeUnknownAssetKind(received: unknown): UnknownAssetKind {
  return { received, allowed: ASSET_KINDS };
}
