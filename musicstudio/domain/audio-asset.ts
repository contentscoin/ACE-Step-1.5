/**
 * Audio_Asset model and its stored-state constraints (design §4.1).
 *
 * Requirements 19.1, 19.3, 19.4, 19.9, 19.10, 19.11, 19.15; provenance carries
 * the licence ruling (Req 33.7) and the Quality_Threshold_Set version (Req 34.6).
 * Every rule below has a matching CHECK constraint in
 * `db/migrations/0003_audio_asset.sql`.
 */

import { isAssetKind, isLoopableAssetKind, type AssetKind } from './asset-kind';
import { CANONICAL_SAMPLE_RATE, validateProvenance, type AssetProvenance } from './provenance';

export const ASSET_NAME_MIN_LENGTH = 1;
export const ASSET_NAME_MAX_LENGTH = 200;
export const ASSET_DURATION_MIN_MS = 1;
export const ASSET_DURATION_MAX_MS = 3_600_000;
export const ASSET_CHANNELS = [1, 2] as const;

/** Stored when the engine supplies no seed (Req 19.3). */
export const SEED_ABSENT = -1;

export interface AudioAsset {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly assetKind: AssetKind;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly engineId: string;
  readonly seed: number;
  readonly isLoop: boolean;
  /** Folded commercial-use flag (design §4.3) — see `commercial-use.ts`. */
  readonly commercialUseAllowed: boolean;
  readonly provenance: AssetProvenance;
  readonly createdAtMs: number;
  readonly isDeleted: boolean;
}

export type AudioAssetViolation =
  | 'asset_kind_unknown'
  | 'name_length'
  | 'duration_range'
  | 'sample_rate_not_canonical'
  | 'channels_range'
  | 'engine_id_required'
  | 'seed_range'
  | 'loop_flag_not_applicable'
  | 'commercial_use_exceeds_provenance'
  | 'provenance_invalid';

/**
 * Validate a stored-state candidate. Returns every violated rule so the caller
 * can report them together (Req 19.15 expects the violated constraint and the
 * permitted values, not just the first failure).
 */
export function validateAudioAsset(asset: AudioAsset): AudioAssetViolation[] {
  const violations: AudioAssetViolation[] = [];

  if (!isAssetKind(asset.assetKind)) violations.push('asset_kind_unknown');

  if (
    asset.name.length < ASSET_NAME_MIN_LENGTH ||
    asset.name.length > ASSET_NAME_MAX_LENGTH
  ) {
    violations.push('name_length');
  }

  if (
    !Number.isInteger(asset.durationMs) ||
    asset.durationMs < ASSET_DURATION_MIN_MS ||
    asset.durationMs > ASSET_DURATION_MAX_MS
  ) {
    violations.push('duration_range');
  }

  if (asset.sampleRate !== CANONICAL_SAMPLE_RATE) violations.push('sample_rate_not_canonical');

  if (!(ASSET_CHANNELS as readonly number[]).includes(asset.channels)) {
    violations.push('channels_range');
  }

  if (asset.engineId.trim().length === 0) violations.push('engine_id_required');

  if (!Number.isInteger(asset.seed) || (asset.seed < 0 && asset.seed !== SEED_ABSENT)) {
    violations.push('seed_range');
  }

  if (asset.isLoop && isAssetKind(asset.assetKind) && !isLoopableAssetKind(asset.assetKind)) {
    violations.push('loop_flag_not_applicable');
  }

  if (asset.commercialUseAllowed && !asset.provenance.commercialUseAllowed) {
    violations.push('commercial_use_exceeds_provenance');
  }

  if (validateProvenance(asset.provenance).length > 0) violations.push('provenance_invalid');

  return violations;
}

/** Rejection payload for Req 19.15 / 19.9: violated constraint plus its limits. */
export interface AudioAssetRejection {
  readonly violations: readonly AudioAssetViolation[];
  readonly limits: {
    readonly nameLength: readonly [number, number];
    readonly durationMs: readonly [number, number];
    readonly sampleRate: number;
    readonly channels: readonly number[];
  };
}

export function describeAudioAssetRejection(
  violations: readonly AudioAssetViolation[],
): AudioAssetRejection {
  return {
    violations,
    limits: {
      nameLength: [ASSET_NAME_MIN_LENGTH, ASSET_NAME_MAX_LENGTH],
      durationMs: [ASSET_DURATION_MIN_MS, ASSET_DURATION_MAX_MS],
      sampleRate: CANONICAL_SAMPLE_RATE,
      channels: ASSET_CHANNELS,
    },
  };
}
