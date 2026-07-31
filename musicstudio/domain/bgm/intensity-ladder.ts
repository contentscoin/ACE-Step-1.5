/**
 * Intensity variants of one background-music cue (Requirements 21.9, 21.10, 21.11).
 *
 * Two halves, and keeping them apart is the design:
 *
 * - **Plan.** `planIntensityLadder` turns a count and a gap into one target loudness
 *   per step. It satisfies Requirement 21.11 *by construction* — steps are `1..count`,
 *   distinct and ascending, and adjacent targets differ by exactly the gap, which the
 *   validator has already confined to 1.0–6.0 LUFS. Nothing measured can make a plan
 *   invalid, so the plan is where the invariant is guaranteed.
 * - **Verify.** `verifyIntensityLadder` checks the same invariant against what was
 *   actually produced, plus Requirement 21.10's length spread. The plan cannot make the
 *   engine obey it, so the produced assets are measured and judged.
 *
 * **Integration point (task 3.3).** Closing the gap between a plan and a measurement
 * is loudness normalisation, which is the Mastering_Assistant's (Requirement 30.2–30.5)
 * and not this task's. Until it exists, a cue whose variants miss the ladder is reported
 * with the violated invariant rather than silently corrected: Requirement 21.11 is
 * stated as an invariant and, unlike Requirement 21.18's loop criteria, is given no
 * regeneration remedy, so inventing one here would be inventing requirement text.
 */

import {
  BGM_INTENSITY_GAP_MAX_LUFS,
  BGM_INTENSITY_GAP_MIN_LUFS,
  BGM_INTENSITY_STEP_MAX,
  BGM_INTENSITY_STEP_MIN,
  BGM_INTENSITY_VARIANT_COUNT_MAX,
  BGM_INTENSITY_VARIANT_COUNT_MIN,
  BGM_VARIANT_DURATION_SPREAD_MAX_MS,
} from './bounds';

export interface IntensityVariantPlan {
  /** Requirement 21.11: 1–4, distinct within the cue. */
  readonly step: number;
  /** Loudness this variant aims for, LUFS. */
  readonly targetLoudnessLufs: number;
}

export interface IntensityLadderPlanInput {
  readonly count: number;
  readonly baseLoudnessLufs: number;
  readonly gapLufs: number;
}

/**
 * One target per step, ascending.
 *
 * Step 1 sits at the base loudness and each later step is `gapLufs` above the one
 * below, which is exactly Requirement 21.11's relation. The count and gap are clamped
 * rather than rejected: `validateBgmVariantRequest` already refuses an out-of-range
 * request with the field and its bounds, so a value arriving here is either valid or a
 * programming error, and clamping keeps a programming error from producing a ladder
 * that violates the invariant it exists to uphold.
 */
export function planIntensityLadder(
  input: IntensityLadderPlanInput,
): readonly IntensityVariantPlan[] {
  const count = clamp(
    Math.round(input.count),
    BGM_INTENSITY_VARIANT_COUNT_MIN,
    BGM_INTENSITY_VARIANT_COUNT_MAX,
  );
  const gap = clamp(input.gapLufs, BGM_INTENSITY_GAP_MIN_LUFS, BGM_INTENSITY_GAP_MAX_LUFS);

  return Array.from({ length: count }, (_unused, index) => ({
    step: BGM_INTENSITY_STEP_MIN + index,
    targetLoudnessLufs: input.baseLoudnessLufs + gap * index,
  }));
}

/** What a produced variant measures. */
export interface MeasuredIntensityVariant {
  readonly assetId: string;
  readonly step: number;
  readonly durationMs: number;
  readonly integratedLoudnessLufs: number;
}

export const INTENSITY_LADDER_INVARIANTS = [
  /** Requirement 21.9: 1–4 variants. */
  'variant_count',
  /** Requirement 21.10: lengths within 10 ms of each other. */
  'duration_spread',
  /** Requirement 21.11, first half: distinct steps in 1–4. */
  'intensity_steps',
  /** Requirement 21.11, second half: adjacent gap in 1.0–6.0 LUFS. */
  'loudness_gap',
] as const;

export type IntensityLadderInvariant = (typeof INTENSITY_LADDER_INVARIANTS)[number];

export const LADDER_INVARIANT_REQUIREMENT: Readonly<
  Record<IntensityLadderInvariant, string>
> = {
  variant_count: '21.9',
  duration_spread: '21.10',
  intensity_steps: '21.11',
  loudness_gap: '21.11',
};

export interface IntensityLadderVerdict {
  readonly satisfied: boolean;
  readonly unmet: readonly IntensityLadderInvariant[];
  /** Loudness gaps between adjacent steps, ascending. `count − 1` entries. */
  readonly gapsLufs: readonly number[];
  /** Longest minus shortest, milliseconds. */
  readonly durationSpreadMs: number;
}

/**
 * Requirements 21.9, 21.10 and 21.11 over a produced set.
 *
 * A single variant satisfies the gap invariant vacuously — there is no adjacent pair —
 * which is right: Requirement 21.9 permits a count of 1, so a rule about gaps cannot
 * make the permitted case fail.
 */
export function verifyIntensityLadder(
  variants: readonly MeasuredIntensityVariant[],
): IntensityLadderVerdict {
  const unmet: IntensityLadderInvariant[] = [];

  if (
    variants.length < BGM_INTENSITY_VARIANT_COUNT_MIN ||
    variants.length > BGM_INTENSITY_VARIANT_COUNT_MAX
  ) {
    unmet.push('variant_count');
  }

  const durations = variants.map((variant) => variant.durationMs);
  const durationSpreadMs =
    durations.length === 0 ? 0 : Math.max(...durations) - Math.min(...durations);
  if (durationSpreadMs > BGM_VARIANT_DURATION_SPREAD_MAX_MS) unmet.push('duration_spread');

  const steps = variants.map((variant) => variant.step);
  const distinct = new Set(steps).size === steps.length;
  const inRange = steps.every(
    (step) =>
      Number.isInteger(step) && step >= BGM_INTENSITY_STEP_MIN && step <= BGM_INTENSITY_STEP_MAX,
  );
  if (!distinct || !inRange || steps.length === 0) unmet.push('intensity_steps');

  // Ordered by step, because Requirement 21.11 compares a variant with "한 단계 낮은"
  // one — the neighbour in step order, not in submission order.
  const ordered = [...variants].sort((left, right) => left.step - right.step);
  const gapsLufs = ordered
    .slice(1)
    .map(
      (variant, index) =>
        variant.integratedLoudnessLufs - (ordered[index]?.integratedLoudnessLufs ?? 0),
    );

  if (
    gapsLufs.some(
      (gap) =>
        !Number.isFinite(gap) || gap < BGM_INTENSITY_GAP_MIN_LUFS || gap > BGM_INTENSITY_GAP_MAX_LUFS,
    )
  ) {
    unmet.push('loudness_gap');
  }

  return { satisfied: unmet.length === 0, unmet, gapsLufs, durationSpreadMs };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
