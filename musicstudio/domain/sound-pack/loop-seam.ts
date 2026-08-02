/**
 * Requirement 24.6: loop-cue seam continuity — **two** criteria, not one.
 *
 * This module exists because of a difference between two clauses that is easy to miss and
 * expensive to miss. Compare them:
 *
 * - **Requirement 22.14** (a looping sound effect): the last 10 ms and first 10 ms RMS differ
 *   by no more than 1.0 dB. One quantity.
 * - **Requirement 24.6** (a loop cue in a sound pack): the same RMS rule, **and** "마지막 샘플
 *   값과 첫 샘플 값의 차이의 절대값을 해당 큐 최대 절대 진폭의 5% 이하로 유지한다" — the
 *   sample-step rule of Requirement 21.8.
 *
 * So a pack's six loop cues are held to a strictly stronger rule than a standalone looping
 * sound effect, and driving `SfxService` per cue — which is how the pack is generated, see
 * `services/sound/sound-pack-service.ts` — applies only the weaker one. The extra criterion
 * has to be applied by the pack, and `domain/sfx/loop-seam.ts`'s own header anticipates
 * exactly this: it records as an open question whether an `sfx` loop *ought* to be held to
 * the sample-step rule, notes that equal energy either side says nothing about whether the
 * waveform is continuous, and declines to add it because Requirement 22 does not ask. 24.6
 * asks.
 *
 * Like `domain/sfx/loop-seam.ts`, this is a **selection** over `domain/bgm/loop-seam.ts` and
 * contains no arithmetic of its own. One seam measurement in the system, three clauses
 * choosing different subsets of it.
 *
 * The two criteria 24.6 does *not* name are still not applied:
 *
 * - **edge energy (21.16)** — 24.6 does not mention it, and a UI loop is short enough that a
 *   100 ms edge window is a large fraction of it, so applying it would reject cues on a
 *   criterion tuned for multi-bar music beds.
 * - **bar alignment (21.17)** — a UI cue has no tempo, for the reason `SFX_NO_TEMPO` states.
 */

import {
  evaluateLoopSeam,
  type LoopMeasurement,
  type LoopSeamCriterion,
  type LoopSeamVerdict,
} from '../bgm/loop-seam';
import type { LoopSeamThresholds } from '../quality/loop-seam-thresholds';

/** Requirement 24.6's two criteria. */
export const PACK_LOOP_SEAM_CRITERIA: readonly LoopSeamCriterion[] = [
  'seam_rms_difference',
  'seam_sample_step',
];

export function evaluateCueLoopSeam(
  measurement: LoopMeasurement,
  thresholds: LoopSeamThresholds,
): LoopSeamVerdict {
  return evaluateLoopSeam(measurement, thresholds, PACK_LOOP_SEAM_CRITERIA);
}

/** One loop cue's verdict, named. */
export interface CueLoopSeamVerdict {
  readonly cueName: string;
  readonly verdict: LoopSeamVerdict;
}

/** The loop cues whose seam fails 24.6, in cue order. */
export function seamOffenders(
  verdicts: readonly CueLoopSeamVerdict[],
): readonly CueLoopSeamVerdict[] {
  return verdicts.filter((entry) => !entry.verdict.satisfied);
}
