import { describe, expect, it } from 'vitest';

import {
  isValidEngineDescriptor,
  validateEngineDescriptor,
} from '../../../adapters/registry/descriptor-validation';
import {
  DAILY_QUOTA_MAX,
  ENGINE_ID_MAX_LENGTH,
  MAX_OUTPUT_DURATION_MS_MAX,
  MAX_OUTPUT_DURATION_MS_MIN,
  SAMPLE_RATE_MAX,
  SAMPLE_RATE_MIN,
} from '../../../adapters/registry/engine-descriptor';
import { engineDescriptor, permissiveLicense } from '../../support/registry-harness';

/**
 * Requirement 20.1 field domains and Requirement 20.23 rejection payload.
 * Requirement 33.1/33.6 License_Descriptor items.
 */
describe('Engine_Descriptor validation (Req 20.1, 20.23)', () => {
  it('accepts a descriptor that fills every required field', () => {
    expect(validateEngineDescriptor(engineDescriptor('ace-step-1.5'))).toEqual([]);
    expect(isValidEngineDescriptor(engineDescriptor('ace-step-1.5'))).toBe(true);
  });

  it('accepts the inclusive bounds of every numeric domain', () => {
    const atLowerBounds = engineDescriptor('lower', {
      maxOutputDurationMs: MAX_OUTPUT_DURATION_MS_MIN,
      sampleRate: SAMPLE_RATE_MIN,
      dailyQuota: { maxRequests: 1, maxGpuSeconds: 1 },
    });
    const atUpperBounds = engineDescriptor('u'.repeat(ENGINE_ID_MAX_LENGTH), {
      maxOutputDurationMs: MAX_OUTPUT_DURATION_MS_MAX,
      sampleRate: SAMPLE_RATE_MAX,
      supportedAssetKinds: ['song', 'bgm', 'sfx', 'dialogue', 'stem', 'mix'],
      supportedInputModalities: ['text', 'audio', 'video'],
      dailyQuota: { maxRequests: DAILY_QUOTA_MAX, maxGpuSeconds: DAILY_QUOTA_MAX },
    });

    expect(validateEngineDescriptor(atLowerBounds)).toEqual([]);
    expect(validateEngineDescriptor(atUpperBounds)).toEqual([]);
  });

  it.each([
    ['engineId', { engineId: '' }],
    ['engineId', { engineId: 'x'.repeat(ENGINE_ID_MAX_LENGTH + 1) }],
    ['supportedAssetKinds', { supportedAssetKinds: [] }],
    ['supportedAssetKinds', { supportedAssetKinds: ['song', 'song'] }],
    ['supportedAssetKinds', { supportedAssetKinds: ['orchestra'] }],
    ['supportedInputModalities', { supportedInputModalities: [] }],
    ['supportedInputModalities', { supportedInputModalities: ['midi'] }],
    ['maxOutputDurationMs', { maxOutputDurationMs: MAX_OUTPUT_DURATION_MS_MIN - 1 }],
    ['maxOutputDurationMs', { maxOutputDurationMs: MAX_OUTPUT_DURATION_MS_MAX + 1 }],
    ['sampleRate', { sampleRate: SAMPLE_RATE_MIN - 1 }],
    ['sampleRate', { sampleRate: SAMPLE_RATE_MAX + 1 }],
    ['executionLocation', { executionLocation: 'edge' }],
    ['dailyQuota.maxRequests', { dailyQuota: { maxRequests: 0, maxGpuSeconds: 10 } }],
    ['dailyQuota.maxGpuSeconds', { dailyQuota: { maxRequests: 10, maxGpuSeconds: DAILY_QUOTA_MAX + 1 } }],
  ])('reports %s when it is missing or out of range', (field, override) => {
    const violations = validateEngineDescriptor({
      ...engineDescriptor('candidate'),
      ...override,
    });
    expect(violations).toContain(field);
  });

  it('reports every violation at once rather than only the first (Req 20.23)', () => {
    const violations = validateEngineDescriptor({
      engineId: '',
      supportedAssetKinds: [],
      supportedInputModalities: ['hologram'],
      maxOutputDurationMs: 10,
      sampleRate: 8_000,
      executionLocation: 'cloud',
      dailyQuota: { maxRequests: 0, maxGpuSeconds: 0 },
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        'engineId',
        'supportedAssetKinds',
        'supportedInputModalities',
        'maxOutputDurationMs',
        'sampleRate',
        'executionLocation',
        'dailyQuota.maxRequests',
        'dailyQuota.maxGpuSeconds',
      ]),
    );
    // The five License_Descriptor items are missing entirely here (Req 33.6).
    expect(violations).toContain('license');
  });

  it.each([
    'license.codeLicenseId',
    'license.weightLicenseId',
    'license.commercialUseAllowed',
    'license.attributionText',
    'license.licenseUrls',
  ])('reports the missing License_Descriptor item %s (Req 33.6)', (field) => {
    const license: Record<string, unknown> = { ...permissiveLicense() };
    delete license[field.replace('license.', '')];

    expect(validateEngineDescriptor(engineDescriptor('e', { license: license as never }))).toContain(
      field,
    );
  });

  it('rejects more than five licence links and an over-long attribution text', () => {
    const tooManyUrls = engineDescriptor('urls', {
      license: permissiveLicense({
        licenseUrls: ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => `https://example.test/${s}`),
      }),
    });
    const tooLongAttribution = engineDescriptor('attr', {
      license: permissiveLicense({ attributionText: 'x'.repeat(501) }),
    });

    expect(validateEngineDescriptor(tooManyUrls)).toContain('license.licenseUrls');
    expect(validateEngineDescriptor(tooLongAttribution)).toContain('license.attributionText');
  });

  it('names the offending third-party component (Req 33.4)', () => {
    const descriptor = engineDescriptor('composite', {
      licenseComponents: [permissiveLicense(), { ...permissiveLicense(), licenseUrls: [] }],
    });

    expect(validateEngineDescriptor(descriptor)).toEqual(['licenseComponents[1].licenseUrls']);
  });
});
