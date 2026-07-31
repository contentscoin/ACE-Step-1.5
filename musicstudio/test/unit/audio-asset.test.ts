import { describe, expect, it } from 'vitest';

import {
  ASSET_KINDS,
  describeUnknownAssetKind,
  isAssetKind,
  isLoopableAssetKind,
  requiresLineage,
} from '../../domain/asset-kind';
import {
  SEED_ABSENT,
  describeAudioAssetRejection,
  validateAudioAsset,
  type AudioAsset,
} from '../../domain/audio-asset';
import { validateProvenance, type AssetProvenance } from '../../domain/provenance';
import { validateAccount } from '../../domain/account';
import { validateVersionSet, type GenerationVersion } from '../../domain/generation-version';

const provenance: AssetProvenance = {
  engineId: 'ace-step-1.5',
  weightLicenseId: 'apache-2.0',
  attributionText: 'ACE-Step 1.5',
  commercialUseAllowed: true,
  nonCommercialLicenseListVersion: 3,
  recordedAtMs: 1_800_000_000_000,
  aiGenerated: true,
  qualityThresholdSetVersion: 7,
};

const asset: AudioAsset = {
  id: 'asset-1',
  ownerId: 'account-1',
  name: 'Night Drive',
  assetKind: 'song',
  durationMs: 180_000,
  sampleRate: 48_000,
  channels: 2,
  engineId: 'ace-step-1.5',
  seed: 42,
  isLoop: false,
  commercialUseAllowed: true,
  provenance,
  createdAtMs: 1_800_000_000_000,
  isDeleted: false,
};

describe('Asset_Kind (Requirements 19.1, 19.9, 19.10)', () => {
  it('defines exactly the six kinds', () => {
    expect(ASSET_KINDS).toEqual(['song', 'bgm', 'sfx', 'dialogue', 'stem', 'mix']);
  });

  it('rejects an unknown kind and returns the allowed list', () => {
    expect(isAssetKind('podcast')).toBe(false);
    expect(describeUnknownAssetKind('podcast')).toEqual({
      received: 'podcast',
      allowed: ASSET_KINDS,
    });
  });

  it('allows the loop flag only for bgm and sfx', () => {
    expect(ASSET_KINDS.filter(isLoopableAssetKind)).toEqual(['bgm', 'sfx']);
  });

  it('requires lineage only for stem and mix', () => {
    expect(ASSET_KINDS.filter(requiresLineage)).toEqual(['stem', 'mix']);
  });
});

describe('Audio_Asset stored state (Requirements 19.3, 19.4, 19.11, 19.15)', () => {
  it('accepts a well-formed asset', () => {
    expect(validateAudioAsset(asset)).toEqual([]);
  });

  it('accepts the fixed no-seed value', () => {
    expect(validateAudioAsset({ ...asset, seed: SEED_ABSENT })).toEqual([]);
  });

  it.each([
    ['', 'name_length'],
    ['x'.repeat(201), 'name_length'],
  ] as const)('rejects name %#', (name, violation) => {
    expect(validateAudioAsset({ ...asset, name })).toContain(violation);
  });

  it.each([0, 3_600_001, 1.5])('rejects duration %s ms', (durationMs) => {
    expect(validateAudioAsset({ ...asset, durationMs })).toContain('duration_range');
  });

  it('rejects a non-48kHz sample rate', () => {
    expect(validateAudioAsset({ ...asset, sampleRate: 44_100 })).toContain(
      'sample_rate_not_canonical',
    );
  });

  it.each([0, 3])('rejects %s channels', (channels) => {
    expect(validateAudioAsset({ ...asset, channels })).toContain('channels_range');
  });

  it('rejects a loop flag on a song', () => {
    expect(validateAudioAsset({ ...asset, isLoop: true })).toContain(
      'loop_flag_not_applicable',
    );
  });

  it('accepts a loop flag on bgm', () => {
    expect(validateAudioAsset({ ...asset, assetKind: 'bgm', isLoop: true })).toEqual([]);
  });

  it('rejects a permitted flag the provenance does not support', () => {
    const restricted = { ...provenance, commercialUseAllowed: false };

    expect(
      validateAudioAsset({ ...asset, provenance: restricted, commercialUseAllowed: true }),
    ).toContain('commercial_use_exceeds_provenance');
  });

  it('returns the permitted values alongside the violations', () => {
    expect(describeAudioAssetRejection(['duration_range']).limits).toMatchObject({
      durationMs: [1, 3_600_000],
      sampleRate: 48_000,
      channels: [1, 2],
    });
  });
});

describe('provenance (Requirements 33.7, 34.6)', () => {
  it('accepts a complete record', () => {
    expect(validateProvenance(provenance)).toEqual([]);
  });

  it('rejects attribution text longer than 500 characters', () => {
    expect(validateProvenance({ ...provenance, attributionText: 'a'.repeat(501) })).toContain(
      'attribution_text_length',
    );
  });

  it('rejects a non-positive Quality_Threshold_Set version', () => {
    expect(validateProvenance({ ...provenance, qualityThresholdSetVersion: 0 })).toContain(
      'quality_threshold_set_version_range',
    );
  });
});

describe('Account (design §4.1)', () => {
  const account = {
    id: 'account-1',
    email: 'owner@studio.example',
    passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
    planId: 'free',
    creditBalance: 0,
    createdAtMs: 1_800_000_000_000,
  };

  it('accepts a well-formed account', () => {
    expect(validateAccount(account)).toEqual([]);
  });

  it('rejects a negative credit balance', () => {
    expect(validateAccount({ ...account, creditBalance: -1 })).toContain(
      'credit_balance_negative',
    );
  });

  it('rejects a malformed email', () => {
    expect(validateAccount({ ...account, email: 'owner@studio' })).toContain('email_format');
  });
});

describe('Generation_Version set (design §4.1)', () => {
  const version = (overrides: Partial<GenerationVersion>): GenerationVersion => ({
    id: 'version-1',
    assetId: 'asset-1',
    name: 'Original',
    effectChain: [],
    derivedFromVersionId: null,
    isDefault: true,
    isOriginal: true,
    durationMs: 180_000,
    createdAtMs: 1_800_000_000_000,
    ...overrides,
  });

  it('accepts one default and one original', () => {
    expect(validateVersionSet('asset-1', [version({})])).toEqual([]);
  });

  it('rejects two defaults', () => {
    const versions = [version({}), version({ id: 'version-2', isOriginal: false })];

    expect(validateVersionSet('asset-1', versions)).toContain('multiple_default_versions');
  });

  it('rejects a version belonging to another asset', () => {
    expect(validateVersionSet('asset-1', [version({ assetId: 'asset-2' })])).toContain(
      'foreign_asset_version',
    );
  });
});
