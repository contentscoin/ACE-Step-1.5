/**
 * The two model tiers of Requirements 22.9–22.11, and the sampling-step window each
 * one admits.
 *
 * The tier is the *only* thing that decides the step window, which is why the window
 * is a property of the tier here rather than a pair of constants the validator picks
 * between. Requirement 22.10 and 22.11 overlap at exactly one value — 8 steps is the
 * top of the fast range and the bottom of the high-quality one — so a step count is
 * not valid or invalid on its own: 4 steps is valid for `fast` and invalid for
 * `high_quality`, and 30 is the reverse. Validation is therefore always relative to a
 * tier, and `stepBoundsFor` is the single place that relation is expressed.
 *
 * Design §3.6 names the engines: 고속 = Woosh-DFlow (the distilled model of 22.10),
 * 고품질 = Woosh-Flow (the non-distilled model of 22.11). The mapping from tier to
 * engine identifier lives in `adapters/woosh/`, because which deployment serves a
 * tier is an engine fact; that a tier is distilled or not is a product fact and
 * belongs here.
 */

/** Requirement 22.9: exactly two tiers. */
export const SFX_MODEL_TIERS = ['fast', 'high_quality'] as const;

export type SfxModelTier = (typeof SFX_MODEL_TIERS)[number];

export function isSfxModelTier(value: unknown): value is SfxModelTier {
  return typeof value === 'string' && (SFX_MODEL_TIERS as readonly string[]).includes(value);
}

export interface SamplingStepBounds {
  readonly min: number;
  readonly max: number;
  /** Applied when the caller named no step count (22.10, 22.11). */
  readonly fallback: number;
}

/**
 * Requirement 22.10 for `fast`, Requirement 22.11 for `high_quality`.
 *
 * `distilled` records which of the two the tier uses, because 22.10 and 22.11 do not
 * merely differ in their step window — they name different models. Anything that has
 * to choose a checkpoint reads this rather than re-deriving it from the tier name.
 */
export const SFX_TIER_SAMPLING_STEPS: Readonly<Record<SfxModelTier, SamplingStepBounds>> = {
  // Requirement 22.10: 증류 모델, 1–8 steps, default 8.
  fast: { min: 1, max: 8, fallback: 8 },
  // Requirement 22.11: 비증류 모델, 8–100 steps, default 30.
  high_quality: { min: 8, max: 100, fallback: 30 },
};

export const SFX_TIER_DISTILLED: Readonly<Record<SfxModelTier, boolean>> = {
  fast: true,
  high_quality: false,
};

export function stepBoundsFor(tier: SfxModelTier): SamplingStepBounds {
  return SFX_TIER_SAMPLING_STEPS[tier];
}

export function usesDistilledModel(tier: SfxModelTier): boolean {
  return SFX_TIER_DISTILLED[tier];
}

/** Requirements 22.10, 22.11: is this step count admissible *for this tier*. */
export function isSamplingStepCountFor(tier: SfxModelTier, value: unknown): boolean {
  const bounds = stepBoundsFor(tier);
  return Number.isInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max;
}
