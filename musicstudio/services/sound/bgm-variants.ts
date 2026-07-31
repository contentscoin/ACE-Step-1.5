/**
 * Intensity variants of one background-music cue (Requirements 21.9, 21.10, 21.11).
 *
 * Separate from `bgm-service.ts` because it is a *composition* of it: one variant is
 * one ordinary `BgmService.generate` call, and this module is the loop around them plus
 * the ladder verdict over the results. Keeping it apart means the single-cue path — the
 * one with the loop retry ladder and the refund — is not made harder to read by a second
 * kind of iteration wrapped around it.
 *
 * What each half is responsible for:
 *
 * - **Requirement 21.9's "동일한 BPM, 키, 목표 길이"** is satisfied by construction, not
 *   by a check. Every variant is generated from the *same* validated `BgmParameters`,
 *   with only the intensity caption and the seed differing, so there is no code path on
 *   which two variants of one cue could be asked for different tempi. The verdict still
 *   measures length, because Requirement 21.10 bounds what the engine *returned* rather
 *   than what it was asked for.
 * - **Requirements 21.10 and 21.11** are measured over the produced set and reported.
 *   Not repaired: 21.18 gives the loop criteria an explicit remedy and gives the ladder
 *   invariants none, so regenerating here would be inventing requirement text. Closing a
 *   loudness gap is loudness normalisation — Requirement 30.2–30.5, task 3.3's
 *   Mastering_Assistant — and `planIntensityLadder`'s targets are what it will aim at.
 *
 * Variants are generated in sequence. Requirement 21.9 does not ask for concurrency, and
 * sequence keeps the seed the engine sees a function of the step alone, which is what
 * makes a variant set reproducible.
 */

import {
  planIntensityLadder,
  verifyIntensityLadder,
  type IntensityLadderVerdict,
  type IntensityVariantPlan,
  type MeasuredIntensityVariant,
} from '../../domain/bgm/intensity-ladder';
import type { BgmIntensityVariantRequest } from '../../domain/bgm/request';
import { validateBgmVariantRequest } from '../../domain/bgm/validation';
import type { ModerationDecision } from '../moderation/decision';

import { bgmIntensityLadderUnmet, bgmRequestInvalid } from './bgm-errors';
import type { BgmService } from './bgm-service';
import type { BgmOutcome, ProducedBgm } from './bgm-result';

export interface BgmVariantSubmissionInput {
  readonly accountId: string;
  readonly request: BgmIntensityVariantRequest;
  readonly engineId?: string;
  readonly moderate?: () => ModerationDecision;
}

export interface ProducedBgmVariantSet {
  readonly kind: 'produced';
  /** Ascending by intensity step, so index 0 is step 1. */
  readonly variants: readonly ProducedBgm[];
  /** Requirements 21.10, 21.11 over what was produced. */
  readonly ladder: IntensityLadderVerdict;
  /** The loudness targets task 3.3 will normalise towards. */
  readonly plan: readonly IntensityVariantPlan[];
}

/**
 * A variant set, or the first variant outcome that was not audio.
 *
 * A block applies to the whole request — every variant carries the same user text, so
 * Requirement 16.2 refuses all of them for one reason — and a transport failure is
 * Requirement 6's to remedy, with its own refund already settled. Either way the
 * remaining variants are not attempted: generating siblings for a cue that cannot be
 * completed would charge for audio nobody can use.
 */
export type BgmVariantOutcome =
  | ProducedBgmVariantSet
  | Exclude<BgmOutcome, { readonly kind: 'produced' }>;

/**
 * Requirement 21.9's entry point.
 *
 * Throws `bgm_request_invalid` when the count or the gap is out of range (21.3, 21.9),
 * and `bgm_intensity_ladder_unmet` when the produced set violates 21.10 or 21.11.
 * A single-variant request is a legitimate one and produces a set of one, whose ladder
 * verdict is satisfied vacuously — there is no adjacent pair to have a gap.
 */
export async function generateBgmIntensityVariants(
  service: BgmService,
  input: BgmVariantSubmissionInput,
): Promise<BgmVariantOutcome> {
  const validation = validateBgmVariantRequest(input.request);
  if (validation.kind === 'invalid') throw bgmRequestInvalid(validation.violations);

  const { variantCount, intensityGapLufs, baseLoudnessLufs } = validation.parameters;
  const plan = planIntensityLadder({
    count: variantCount,
    gapLufs: intensityGapLufs,
    baseLoudnessLufs,
  });

  // `validation.parameters.cue` is the resolved cue, and it is deliberately *not* threaded
  // into the calls below: each variant goes through `BgmService.generate` with the
  // original request, so there is one route from a request to `BgmParameters` rather than
  // two. Requirement 21.9's "동일한 BPM, 키, 목표 길이" holds because that route is
  // deterministic and the request does not change between variants, which the test
  // "asks the engine for the same BPM, key and length every time" pins.

  const variants: ProducedBgm[] = [];

  for (const step of plan) {
    const outcome = await service.generate({
      accountId: input.accountId,
      request: input.request,
      intensityStep: step.step,
      intensityVariantCount: variantCount,
      // Requirement 21.9 pins every other parameter across the ladder, so without a
      // per-variant seed the engine would be asked the same question `variantCount`
      // times. The step is the offset, so a set is reproducible from the request.
      seedOffset: step.step,
      ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });

    if (outcome.kind !== 'produced') return outcome;
    variants.push(outcome);
  }

  const ladder = verifyIntensityLadder(variants.map(measuredVariant));
  if (!ladder.satisfied) {
    throw bgmIntensityLadderUnmet({
      unmet: ladder.unmet,
      gapsLufs: ladder.gapsLufs,
      durationSpreadMs: ladder.durationSpreadMs,
    });
  }

  return { kind: 'produced', variants, ladder, plan };
}

/** The four numbers Requirements 21.10 and 21.11 judge, off a produced variant. */
function measuredVariant(produced: ProducedBgm): MeasuredIntensityVariant {
  return {
    assetId: produced.assetId,
    step: produced.metadata.intensityStep,
    durationMs: produced.metadata.durationMs,
    integratedLoudnessLufs: produced.metadata.integratedLoudnessLufs,
  };
}
