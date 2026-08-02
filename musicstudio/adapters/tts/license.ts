/**
 * License_Descriptors and Engine_Descriptors for the two TTS engines (Requirements 20.1, 33.1).
 *
 * **Unverified, and deliberately conservative.** The requirements appendix's licence table names
 * Woosh, DeepAFx, UI SFX, Amicro and ACE-Step; it says nothing about a TTS engine, and design
 * §3.6 names the two only as "TTS Engine A" and "TTS Engine B". So there is no published
 * identifier to transcribe, and inventing a permissive one would be the dangerous direction: an
 * engine wrongly recorded as commercially usable produces assets Requirement 33.21 then
 * propagates that permission to, and Requirement 33.22 makes the download gate unbypassable in
 * only one direction.
 *
 * Both descriptors therefore declare `commercialUseAllowed: false` with the provider-specified
 * placeholder identifiers a deployment replaces. If a deployment's engine *is* commercially
 * licensed, it registers a descriptor saying so and `ruleCommercialUse` records that; nothing
 * here has to change for that to work, because the ruling reads the descriptor rather than this
 * file. **§14 risk to settle with whoever owns the TTS deployments.**
 *
 * `executionLocation` is `remote` for both, which is the honest declaration for a hosted speech
 * service and is what makes Requirement 33.5's terms-of-service link applicable — recorded as a
 * placeholder for the same reason as the identifiers.
 */

import { DIALOGUE_DURATION_MS_CEILING } from '../../domain/speech/request';
import type { EngineDescriptor } from '../registry/engine-descriptor';
import type { LicenseDescriptor } from '../registry/license-descriptor';

import { TTS_ENGINE_CAPABILITIES, type TtsEngineCapabilities } from './capabilities';

/**
 * Longest dialogue asset an engine is asked for, in milliseconds.
 *
 * Requirement 19.11's one-hour Audio_Asset ceiling, which is also
 * `MAX_OUTPUT_DURATION_MS_MAX` in `adapters/registry/engine-descriptor.ts` — the largest a
 * descriptor may declare. `estimatedDialogueDurationMs` clamps to the same value, so routing never
 * refuses a dialogue request for a length the estimate produced, and an engine that genuinely
 * cannot manage an hour of speech declares less.
 */
export const TTS_MAX_OUTPUT_DURATION_MS = DIALOGUE_DURATION_MS_CEILING;

export const TTS_LICENSE: LicenseDescriptor = {
  codeLicenseId: 'provider-specified',
  weightLicenseId: 'provider-specified',
  // See the module comment: `false` until a deployment states otherwise, because the unsafe
  // direction of this field is `true`.
  commercialUseAllowed: false,
  attributionText: 'Synthesised speech produced by a third-party text-to-speech engine.',
  licenseUrls: ['https://example.invalid/tts-license'],
  termsOfServiceUrl: 'https://example.invalid/tts-terms',
};

export interface TtsDescriptorOptions {
  /** Requirement 20.12. Defaults are placeholders for an operator to set. */
  readonly dailyQuota?: EngineDescriptor['dailyQuota'];
  readonly gpuSecondsPerRequest?: number;
  readonly license?: LicenseDescriptor;
}

/**
 * The Engine_Descriptor for one TTS engine.
 *
 * `supportedAssetKinds` is `['dialogue']` alone. A TTS engine cannot produce a song, a loop or a
 * sound effect, and declaring otherwise would let routing (Requirement 20.5) send it work it
 * would refuse — the failure would then surface as an engine error rather than as the routing
 * rejection Requirement 20.4 asks for.
 *
 * `supportedInputModalities` is `['text']` for engine A and `['text', 'audio']` for engine B,
 * because Requirement 26.24's voice conversion submits *audio* and only an engine declaring that
 * modality can receive it. That difference is a real capability difference rather than a
 * convenience, and it is why the modality list is read off the capability record's engine id
 * rather than fixed for both.
 */
export function ttsEngineDescriptor(
  capabilities: TtsEngineCapabilities,
  options: TtsDescriptorOptions = {},
): EngineDescriptor {
  return {
    engineId: capabilities.engineId,
    supportedAssetKinds: ['dialogue'],
    supportedInputModalities: ['text', 'audio'],
    maxOutputDurationMs: TTS_MAX_OUTPUT_DURATION_MS,
    sampleRate: capabilities.sampleRate,
    executionLocation: 'remote',
    license: options.license ?? TTS_LICENSE,
    dailyQuota: options.dailyQuota ?? { maxRequests: 20_000, maxGpuSeconds: 40_000 },
    gpuSecondsPerRequest: options.gpuSecondsPerRequest ?? 1,
  };
}

/** Both descriptors, in the order design §3.6 lists the engines. */
export function ttsEngineDescriptors(
  catalogue: readonly TtsEngineCapabilities[] = TTS_ENGINE_CAPABILITIES,
): readonly EngineDescriptor[] {
  return catalogue.map((capabilities) => ttsEngineDescriptor(capabilities));
}
