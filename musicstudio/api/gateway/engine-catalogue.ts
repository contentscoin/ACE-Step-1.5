import { ACE_STEP_ENGINE_ID } from '../../adapters/registry/default-engines';
import type { EngineDescriptor } from '../../adapters/registry/engine-descriptor';
import type { ProviderRegistry } from '../../adapters/registry/provider-registry';
import { ACE_ENGINE_SAMPLE_RATE } from '../../domain/song/engine-bounds';
import type { EngineLicensePort } from '../../services/generation/adapters/pg-asset-publication';

import type { EngineConfig } from './config';

/**
 * What the composition root tells the registry about ACE-Step (Requirements 20.1, 33.1).
 *
 * Design §3.6 assigns ACE-Step to `song`, `bgm` and `stem`; the edit tasks take a source
 * audio, so `audio` is a supported input modality beside `text`. The output ceiling is
 * Requirement 4.2's 600 s. The sample rate is the engine's own, and the DSP resamples to the
 * canonical 48 kHz on the way into storage regardless (Requirement 19.4) — the descriptor
 * states a fact about the engine, not a promise about the asset.
 *
 * The licence is the one thing here a deployment may need to correct, which is why the
 * weight identifier comes from configuration: the code is MIT (`LICENSE` at the repository
 * root) and the weights ship under the same terms today, but the registry's non-commercial
 * list rules on the *identifier* it is given, so a deployment that swaps in differently
 * licensed weights changes one variable and gets the forced Requirement 33.2 ruling for free.
 */
export const ACE_STEP_LICENSE_URL = 'https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE';
export const ACE_STEP_ATTRIBUTION = 'Generated with ACE-Step 1.5';
/** Requirement 4.2's upper bound on a song, in the descriptor's unit. */
export const ACE_STEP_MAX_OUTPUT_DURATION_MS = 600_000;

export function aceStepDescriptor(engine: EngineConfig): EngineDescriptor {
  return {
    engineId: ACE_STEP_ENGINE_ID,
    supportedAssetKinds: ['song', 'bgm', 'stem'],
    supportedInputModalities: ['text', 'audio'],
    maxOutputDurationMs: ACE_STEP_MAX_OUTPUT_DURATION_MS,
    sampleRate: ACE_ENGINE_SAMPLE_RATE,
    executionLocation: engine.executionLocation,
    license: {
      codeLicenseId: 'MIT',
      weightLicenseId: engine.weightLicenseId,
      commercialUseAllowed: true,
      attributionText: ACE_STEP_ATTRIBUTION,
      licenseUrls: [ACE_STEP_LICENSE_URL],
    },
    dailyQuota: engine.dailyQuota,
  };
}

/**
 * The registry, seen as `EngineLicensePort` (S3's seam, closed here as S3 said it would be).
 *
 * Not simply `descriptor.license`: Requirement 33.2 lets the registry *overrule* the
 * descriptor's `commercialUseAllowed` when either licence is on the non-commercial list, and
 * the ruling in force is `record.commercialUse`, not the request. An asset recording the
 * descriptor's claim would say "commercial use allowed" about an engine the registry had
 * ruled otherwise — which is exactly the disagreement Requirement 33.7 exists to prevent. The
 * list version travels with it for the same reason.
 */
export function registryLicensePort(registry: ProviderRegistry): EngineLicensePort {
  return {
    licenseFor(engineId) {
      const record = registry.find(engineId);
      if (record === undefined) return null;
      return {
        license: {
          ...record.descriptor.license,
          commercialUseAllowed: record.commercialUse.commercialUseAllowed,
        },
        nonCommercialLicenseListVersion: record.commercialUse.listVersion,
      };
    },
  };
}
