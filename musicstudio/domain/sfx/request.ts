/**
 * The sound-effect request as the user makes it, and the parameter set it resolves to.
 *
 * Two types rather than one, for the reason `domain/bgm/request.ts` gives: the request
 * has optional fields because Requirement 22.17 lets the caller omit them, and the
 * parameters have none because by the time anything is submitted every omission has
 * been filled and *reported*. A service reading `SfxParameters` cannot forget a default,
 * and the response can tell the user which values it applied on their behalf, which is
 * the second half of what 22.17 asks for.
 *
 * `appliedDefaults` is part of the parameters rather than a side channel because 22.17
 * requires the applied values in the response — so what was defaulted has to survive
 * as far as the response is built, and the parameters are the only thing that travels
 * that whole way.
 */

import type { SfxModelTier } from './model-tier';

export interface SfxGenerationRequest {
  /** Requirements 22.2, 22.3. */
  readonly prompt: string;
  /** Requirement 22.4. Omitted means Requirement 22.17's 2.0 s. */
  readonly targetLengthSeconds?: number;
  /** Requirement 22.5. Omitted means Requirement 22.17's 4. */
  readonly variantCount?: number;
  /** Requirement 22.9. Omitted means Requirement 22.17's fast tier. */
  readonly modelTier?: SfxModelTier;
  /** Requirements 22.10, 22.11 — validated against the tier's own window. */
  readonly samplingSteps?: number;
  /** Requirement 22.12. Omitted means 7.5. */
  readonly guidanceScale?: number;
  /** Requirement 22.13. Omitted means one is drawn and recorded. */
  readonly seed?: number;
  /** Requirement 22.14 when true, Requirement 22.15 when false. Defaults to false. */
  readonly loop?: boolean;
}

/** Requirement 22.17: which fields the service filled in, for the response. */
export const SFX_DEFAULTABLE_FIELDS = [
  'targetLengthSeconds',
  'variantCount',
  'modelTier',
  'samplingSteps',
  'guidanceScale',
] as const;

export type SfxDefaultableField = (typeof SFX_DEFAULTABLE_FIELDS)[number];

/**
 * A fully determined request. Every field is present; nothing downstream defaults.
 *
 * `seed` is the exception that proves the rule: it is optional here because
 * Requirement 22.13's draw is not a *default* but a random choice, and a random choice
 * cannot be made by a pure function. The service draws it through a port and records
 * the drawn value on each asset (see `domain/sfx/seed.ts`), which is why the resolved
 * parameters carry the caller's seed when there was one and nothing when there was not.
 */
export interface SfxParameters {
  readonly prompt: string;
  readonly targetLengthSeconds: number;
  readonly variantCount: number;
  readonly modelTier: SfxModelTier;
  readonly samplingSteps: number;
  readonly guidanceScale: number;
  readonly loop: boolean;
  /** Present only when the caller named one (Requirement 22.8's precondition). */
  readonly seed?: number;
  /** Requirement 22.17: names of the fields whose values were supplied by default. */
  readonly appliedDefaults: readonly SfxDefaultableField[];
}

/** Milliseconds, for the routing and pricing the job lifecycle does by duration. */
export function targetDurationMs(parameters: SfxParameters): number {
  return Math.round(parameters.targetLengthSeconds * 1000);
}

/**
 * The subset of parameters Requirement 22.8 makes the reproducibility key.
 *
 * 22.8 lists prompt, engine, seed, target length, variant count, sampling steps and
 * guidance scale — and *not* the loop flag, because whether the asset is stored as a
 * loop does not change what the engine is asked to generate. Stated as one function so
 * the key is defined once: the service uses it to derive per-variant seeds, and the
 * property test uses it to state what "the same request" means.
 */
export interface SfxReproducibilityKey {
  readonly prompt: string;
  readonly engineId: string;
  readonly seed: number;
  readonly targetLengthSeconds: number;
  readonly variantCount: number;
  readonly samplingSteps: number;
  readonly guidanceScale: number;
}

export function reproducibilityKey(
  parameters: SfxParameters,
  engineId: string,
  seed: number,
): SfxReproducibilityKey {
  return {
    prompt: parameters.prompt,
    engineId,
    seed,
    targetLengthSeconds: parameters.targetLengthSeconds,
    variantCount: parameters.variantCount,
    samplingSteps: parameters.samplingSteps,
    guidanceScale: parameters.guidanceScale,
  };
}
