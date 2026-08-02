/**
 * The foley request as the user makes it, and the parameter set it resolves to.
 *
 * Two types rather than one, for the reason `domain/sfx/request.ts` and
 * `domain/bgm/request.ts` give: the request has optional fields because Requirements
 * 23.1 and 23.5 let the caller omit them, and the parameters have none because by the
 * time anything is submitted every omission has been filled. A service reading
 * `V2aParameters` cannot forget a default.
 *
 * The prompt is `string | null` in the resolved form rather than optional, because
 * Requirement 23.10 requires the prompt used to be *recorded on the asset lineage* — so
 * "there was no prompt" is a fact to store, not a field to leave out. A missing key and a
 * recorded absence read the same in JSON and mean different things in an audit.
 */

import { V2A_DEFAULT_VARIANT_COUNT } from './bounds';

export interface V2aGenerationRequest {
  /** The staged video upload this foley is generated from (Requirements 23.1, 23.10). */
  readonly uploadId: string;
  /** Requirement 23.5. Omitted or blank means the video alone conditions the engine. */
  readonly prompt?: string;
  /** Requirement 23.1. Omitted means one asset. */
  readonly variantCount?: number;
  /** Requirement 23.14. Omitted means one is drawn and recorded. */
  readonly seed?: number;
}

/** Requirement 23.1's defaultable field. Listed for the response, as 22.17 does. */
export const V2A_DEFAULTABLE_FIELDS = ['variantCount'] as const;

export type V2aDefaultableField = (typeof V2A_DEFAULTABLE_FIELDS)[number];

export interface V2aParameters {
  readonly uploadId: string;
  /** Requirements 23.5, 23.10. `null` when the caller supplied none. */
  readonly prompt: string | null;
  readonly variantCount: number;
  /** Present only when the caller named one (Requirement 23.14's precondition). */
  readonly seed?: number;
  readonly appliedDefaults: readonly V2aDefaultableField[];
}

/**
 * Requirement 23.5's prompt, normalised.
 *
 * Trimmed, and a prompt that is blank after trimming becomes `null` rather than `''`. A
 * whitespace-only prompt is not a generation condition — forwarding it would make the
 * engine's output depend on how many spaces a form submitted, which would quietly break
 * Requirement 23.14's reproducibility promise for two requests a user would call
 * identical.
 */
export function normaliseV2aPrompt(prompt: string | undefined): string | null {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The subset of a request Requirement 23.14 makes the reproducibility key.
 *
 * 23.14 names the seed, the video and the prompt — and nothing else. Notably *not* the
 * variant count: a request for one asset and a request for four ask the engine the same
 * question for the asset they share, which is what makes the promise usable. Stated as one
 * type so the key is defined once, for the service that derives per-variant seeds and for
 * the property test that says what "the same request" means.
 */
export interface V2aReproducibilityKey {
  readonly uploadId: string;
  readonly prompt: string | null;
  readonly engineId: string;
  readonly seed: number;
}

export function v2aReproducibilityKey(
  parameters: V2aParameters,
  engineId: string,
  seed: number,
): V2aReproducibilityKey {
  return { uploadId: parameters.uploadId, prompt: parameters.prompt, engineId, seed };
}

/** Requirement 23.1's default, applied and recorded. */
export function resolveV2aParameters(request: V2aGenerationRequest): V2aParameters {
  const appliedDefaults: V2aDefaultableField[] = [];
  if (request.variantCount === undefined) appliedDefaults.push('variantCount');

  return {
    uploadId: request.uploadId,
    prompt: normaliseV2aPrompt(request.prompt),
    variantCount: request.variantCount ?? V2A_DEFAULT_VARIANT_COUNT,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    appliedDefaults,
  };
}
