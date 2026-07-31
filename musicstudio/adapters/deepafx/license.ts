/**
 * DeepAFx's License_Descriptor and Engine_Descriptor (Requirements 33.1, 33.2, 30.19, 30.23).
 *
 * **The point of this file is that DeepAFx is released for non-commercial use only.** That
 * single fact has to reach the hard commercial-use gate, and it reaches it through the
 * machinery that already exists rather than through a new check — the same route
 * `adapters/woosh/license.ts` documents:
 *
 * 1. `weightLicenseId` is `CC-BY-NC-4.0`, a seed member of
 *    `DEFAULT_NON_COMMERCIAL_LICENSE_IDS`.
 * 2. `ProviderRegistry.register` calls `ruleCommercialUse`, which sees that identifier and
 *    records `commercialUseAllowed: false` **regardless of what the descriptor claimed**
 *    (Requirement 33.2), reporting the grounding identifier and the list version.
 * 3. Requirement 30.23 then requires any asset a DeepAFx suggestion was applied to to be
 *    recorded as non-commercial. That is not a second mechanism: the suggestion carries the
 *    ruling as `MasteringSuggestion.commercialUseAllowed`, and
 *    `resolveCommercialUseOnWrite` in `domain/commercial-use.ts` folds it into the asset's
 *    flag as one term of a conjunction.
 * 4. Requirement 33.21 propagates that `false` to every descendant, and Requirement 33.22
 *    makes the commercial-use refusal a fixed policy no plan, tier, operator setting or
 *    API-key permission can bypass.
 *
 * So there is nothing to enforce here and nothing to bypass. `commercialUseAllowed` is
 * written `false` because that is true; a future editor who "corrects" it to `true` will find
 * the registry overriding them and saying why, which is the property Requirement 33.2 exists
 * to guarantee. **No parameter of any function in this module or in
 * `services/mastering/` can widen permission**, because permission only ever enters a
 * conjunction.
 *
 * ### `executionLocation` is `remote`, and that is Requirement 30.19
 *
 * "파라미터 제안 모델을 MusicStudio 기본 실행 환경과 분리된 별도 서비스로 배포한다". The
 * descriptor says `remote` and therefore carries a `termsOfServiceUrl` (Requirement 33.5).
 * The separation is also why the 120-second budget of Requirement 30.20 exists at all: an
 * in-process suggester could not time out.
 *
 * **Unverified:** the exact licence identifier on the published DeepAFx checkpoints. The
 * repository's stated terms are research/non-commercial, and the *weight* licence is the one
 * that decides the ruling either way, so a correction to the code licence cannot make the
 * model commercially usable. Recorded as a design §14 risk to confirm with the model owner
 * rather than guessed at silently.
 */

import type { EngineDescriptor } from '../registry/engine-descriptor';
import type { LicenseDescriptor } from '../registry/license-descriptor';
import { SUGGESTION_TIMEOUT_MS } from '../../domain/mastering/bounds';

/** The engine identifier the suggestion model is registered under. */
export const DEEPAFX_ENGINE_ID = 'deepafx-mastering-v1';

/** The identifier that grounds the non-commercial ruling. */
export const DEEPAFX_WEIGHT_LICENSE_ID = 'CC-BY-NC-4.0';

export const DEEPAFX_LICENSE: LicenseDescriptor = {
  codeLicenseId: 'Apache-2.0',
  weightLicenseId: DEEPAFX_WEIGHT_LICENSE_ID,
  // Requirement 33.2 will record `false` whatever this says; it says `false` because that is
  // true, and a descriptor that lied here would be a trap for the next reader.
  commercialUseAllowed: false,
  attributionText:
    'Mastering parameters suggested with DeepAFx (CC BY-NC 4.0). Non-commercial use only.',
  licenseUrls: [
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://github.com/adobe-research/DeepAFx',
  ],
  termsOfServiceUrl: 'https://github.com/adobe-research/DeepAFx',
};

/**
 * The suggestion model's Engine_Descriptor.
 *
 * `supportedAssetKinds` is `song` and `bgm`: mastering suggestions are made about mixed
 * musical material, and Requirement 30.1 scopes them to an `Audio_Asset` or a mixdown
 * result. `maxOutputDurationMs` is the longest asset it will analyse rather than anything it
 * emits — the model returns parameters, not audio — which is why it is set to the song
 * ceiling rather than to something derived from an output length that does not exist.
 *
 * **Spec note.** `EngineDescriptor` was designed for engines that *generate* audio, so
 * `sampleRate` and `maxOutputDurationMs` are a slightly awkward fit for an analyser. They
 * are populated with the analysis constraints rather than left out, because Requirement 20.1
 * makes every field mandatory and routing reads them. An `analyser` variant of the descriptor
 * would be cleaner and is worth raising with the spec owner.
 */
export function deepAfxEngineDescriptor(
  options: {
    readonly dailyQuota?: EngineDescriptor['dailyQuota'];
    readonly gpuSecondsPerRequest?: number;
  } = {},
): EngineDescriptor {
  return {
    engineId: DEEPAFX_ENGINE_ID,
    supportedAssetKinds: ['song', 'bgm'],
    supportedInputModalities: ['audio'],
    // The longest asset the analyser accepts (Requirement 21.3's song ceiling).
    maxOutputDurationMs: 240_000,
    sampleRate: 48_000,
    // Requirement 30.19: a separate service.
    executionLocation: 'remote',
    license: DEEPAFX_LICENSE,
    dailyQuota: options.dailyQuota ?? { maxRequests: 20_000, maxGpuSeconds: 10_000 },
    gpuSecondsPerRequest: options.gpuSecondsPerRequest ?? 1,
  };
}

/**
 * Requirement 30.20's budget, re-exported from `domain/mastering/bounds.ts`.
 *
 * Re-exported rather than redeclared so the adapter and the domain read one number. A
 * second literal here is exactly the drift `bounds.ts` exists to prevent.
 */
export const DEEPAFX_SUGGESTION_TIMEOUT_MS = SUGGESTION_TIMEOUT_MS;
