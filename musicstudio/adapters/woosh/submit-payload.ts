/**
 * The Woosh submission body (Requirements 22.1, 22.4, 22.8, 22.10–22.13).
 *
 * A pure function from validated product parameters to a wire object, kept separate from
 * the adapter for the reason `adapters/ace/submit-payload.ts` is: every criterion about what
 * the engine is asked for becomes an assertion about the value this returns, with no engine
 * and no transport involved.
 *
 * The one judgement encoded here is that **every field of Requirement 22.8's reproducibility
 * key appears on the wire**. 22.8 promises sample-identical audio for the same prompt, engine,
 * seed, length, variant count, step count and guidance scale; a field the product layer
 * validates but does not send would leave that promise resting on an engine default that
 * could change under it. `variantCount` is the sole exception and is deliberate: one Woosh
 * submission produces one sample, and the count is expressed as the number of submissions
 * (see `services/sound/sfx-service.ts`), so what makes the *set* reproducible is the seed
 * derivation rather than a field.
 */

import type { SfxParameters } from '../../domain/sfx/request';

import { WOOSH_MODEL_NAME_BY_TIER } from './model-tier';

export interface WooshSubmitPayloadInput {
  readonly parameters: SfxParameters;
  /** The seed for *this* submission — one variant's, from `domain/sfx/seed.ts`. */
  readonly seed: number;
}

/**
 * The body posted to the submit route.
 *
 * Snake-cased because that is the convention every other engine in this system uses on the
 * wire, and duration is sent in seconds because Requirement 22.4 states the target length in
 * seconds and a fractional second is the normal case here — a 0.1 s effect is legal, so
 * rounding to milliseconds and back would be a lossy detour.
 */
export function buildWooshSubmitPayload(
  input: WooshSubmitPayloadInput,
): Readonly<Record<string, unknown>> {
  const { parameters } = input;

  return {
    prompt: parameters.prompt,
    model: WOOSH_MODEL_NAME_BY_TIER[parameters.modelTier],
    duration_seconds: parameters.targetLengthSeconds,
    // Requirements 22.10, 22.11 — already validated against this tier's own window.
    num_inference_steps: parameters.samplingSteps,
    // Requirement 22.12.
    guidance_scale: parameters.guidanceScale,
    // Requirement 22.13, and the field Requirement 22.8's promise rests on.
    seed: input.seed,
    // One sample per submission; see the module comment.
    num_samples: 1,
  };
}
