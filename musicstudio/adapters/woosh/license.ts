/**
 * Woosh's License_Descriptor and Engine_Descriptors (Requirements 33.1, 33.2, 20.1).
 *
 * **The point of this file is that Woosh's published weights are CC-BY-NC.** That single
 * fact has to reach the commercial-use gate, and it reaches it through the machinery that
 * already exists rather than through a new check:
 *
 * 1. `weightLicenseId` is `CC-BY-NC-4.0`, which is a seed member of
 *    `DEFAULT_NON_COMMERCIAL_LICENSE_IDS`.
 * 2. `ProviderRegistry.register` calls `ruleCommercialUse`, which sees that identifier in
 *    the non-commercial list and records `commercialUseAllowed: false` **regardless of what
 *    the descriptor claimed** (Requirement 33.2), reporting the grounding identifier and the
 *    list version.
 * 3. Requirement 33.21 then propagates that `false` to every descendant asset, and
 *    Requirement 33.22 makes the `commercial` refusal a fixed policy that no plan, tier,
 *    operator setting or API-key permission can bypass.
 *
 * So there is nothing to enforce here and nothing to bypass: the descriptor states the
 * licence honestly and the existing ruling does the rest. `commercialUseAllowed` below is
 * written `false` to match the truth, and a future editor who "corrects" it to `true` will
 * find the registry overriding them and saying why — which is the property Requirement 33.2
 * exists to guarantee.
 *
 * **Unverified:** the exact licence identifiers on the two Woosh checkpoints, and whether
 * the code licence differs from the weight licence. The code licence is recorded as Apache-2.0
 * — the usual pairing for a research release with NC weights — and the *weight* licence is the
 * one that decides the ruling either way, so a correction to the code licence cannot make the
 * engine commercially usable. §14 risk to confirm with the engine owner.
 */

import { ASSET_KINDS_FOR_WOOSH } from './asset-kinds';
import { WOOSH_ENGINE_SAMPLE_RATE } from './woosh-engine-adapter';

import type { EngineDescriptor } from '../registry/engine-descriptor';
import type { LicenseDescriptor } from '../registry/license-descriptor';
import {
  WOOSH_DFLOW_ENGINE_ID,
  WOOSH_FLOW_ENGINE_ID,
} from '../registry/default-engines';
import { SFX_TARGET_LENGTH_SECONDS_MAX } from '../../domain/sfx/bounds';
import type { SfxModelTier } from '../../domain/sfx/model-tier';

/** The identifier that grounds the non-commercial ruling. */
export const WOOSH_WEIGHT_LICENSE_ID = 'CC-BY-NC-4.0';

export const WOOSH_LICENSE: LicenseDescriptor = {
  codeLicenseId: 'Apache-2.0',
  weightLicenseId: WOOSH_WEIGHT_LICENSE_ID,
  // Requirement 33.2 will record `false` whatever this says; it says `false` because that
  // is true, and a descriptor that lied here would be a trap for the next reader.
  commercialUseAllowed: false,
  attributionText:
    'Sound effects generated with Woosh (CC BY-NC 4.0). Non-commercial use only.',
  licenseUrls: ['https://creativecommons.org/licenses/by-nc/4.0/'],
};

/**
 * Minimum output length an `sfx` engine must support, in milliseconds.
 *
 * `MAX_OUTPUT_DURATION_MS_MIN` in `engine-descriptor.ts` is 1000 ms, and Requirement 22.4
 * caps a sound effect at 10 s — so the descriptor declares 10 s rather than the 240 s a song
 * engine declares. Routing rejects a request longer than the declared maximum, which is
 * exactly the behaviour wanted: an `sfx` request cannot be longer than 10 s anyway (22.18),
 * and an engine that claimed more would accept work it cannot do.
 */
export const WOOSH_MAX_OUTPUT_DURATION_MS = Math.round(SFX_TARGET_LENGTH_SECONDS_MAX * 1000);

export interface WooshDescriptorOptions {
  /** Requirement 20.12. Defaults are placeholders for an operator to set. */
  readonly dailyQuota?: EngineDescriptor['dailyQuota'];
  readonly gpuSecondsPerRequest?: number;
}

/**
 * The Engine_Descriptor for one tier.
 *
 * `executionLocation` is `local`: both checkpoints are open weights run on the operator's own
 * GPUs, which is why there is no `termsOfServiceUrl` (Requirement 33.5 asks for one only for
 * a remote provider's model).
 */
export function wooshEngineDescriptor(
  tier: SfxModelTier,
  options: WooshDescriptorOptions = {},
): EngineDescriptor {
  return {
    engineId: tier === 'fast' ? WOOSH_DFLOW_ENGINE_ID : WOOSH_FLOW_ENGINE_ID,
    supportedAssetKinds: ASSET_KINDS_FOR_WOOSH,
    supportedInputModalities: ['text'],
    maxOutputDurationMs: WOOSH_MAX_OUTPUT_DURATION_MS,
    sampleRate: WOOSH_ENGINE_SAMPLE_RATE,
    executionLocation: 'local',
    license: WOOSH_LICENSE,
    // The distilled tier is the cheap one; a placeholder ratio, not a measurement.
    dailyQuota: options.dailyQuota ?? { maxRequests: 5_000, maxGpuSeconds: 20_000 },
    gpuSecondsPerRequest: options.gpuSecondsPerRequest ?? (tier === 'fast' ? 1 : 4),
  };
}
