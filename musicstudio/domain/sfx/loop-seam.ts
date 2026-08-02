/**
 * Loop continuity for a looping sound effect (Requirement 22.14).
 *
 * 22.14 imposes exactly one of the four criteria design §5.3 defines for a loop: "루프
 * 자산의 마지막 10밀리초 구간과 첫 10밀리초 구간의 RMS 차이를 1.0데시벨 이하로 유지한다".
 * That is Requirement 21.7's rule verbatim, on the same window, against the same
 * threshold-set member — so this module is a *selection* over
 * `domain/bgm/loop-seam.ts` and contains no arithmetic of its own. There is one seam
 * measurement in the system, not two.
 *
 * The other three are deliberately not applied:
 *
 * - **Bar alignment (21.17)** is meaningless here. A sound effect has no BPM and no time
 *   signature, and Requirement 22 records neither (contrast 21.15, which records both), so
 *   there is no bar for a length to be a multiple of.
 * - **Sample step (21.8)** and **edge energy (21.16)** are simply not asked for.
 *   Requirement 22.14 names one quantity, and 22.15 — the tail rule — applies to the
 *   *non*-loop case, so a looping effect is subject to 22.14 alone. Adding 21.8 or 21.16
 *   to it would be rejecting assets on criteria the requirement does not impose.
 *
 * **Open question for the spec.** Whether a looping sound effect ought to be held to the
 * sample-step rule as well. A loop can satisfy 22.14's RMS window while still clicking at
 * the seam — equal energy either side says nothing about whether the waveform is
 * continuous across it — so 22.14 alone is a weaker guarantee for `sfx` loops than 21.6
 * gives `bgm` loops. That looks like an omission rather than a decision, but closing it is
 * a change to Requirement 22 and not this module's to make.
 */

import {
  evaluateLoopSeam,
  type LoopMeasurement,
  type LoopSeamCriterion,
  type LoopSeamVerdict,
} from '../bgm/loop-seam';
import type { LoopSeamThresholds } from '../quality/loop-seam-thresholds';

/** Requirement 22.14: the one criterion a looping sound effect is judged on. */
export const SFX_LOOP_SEAM_CRITERIA: readonly LoopSeamCriterion[] = ['seam_rms_difference'];

/**
 * Tempo stand-in for a measurement of audio that has none.
 *
 * `LoopMeasurement` carries a BPM and time signature because Requirement 21.17 needs
 * them. A sound effect has neither, and 0 is the honest value: `barDurationMs` maps it to
 * infinity, so the bar arithmetic yields an unaligned result with no `NaN` anywhere — and
 * since `bar_alignment` is not among the applied criteria, that result is reported as
 * evidence and never as a rejection.
 */
export const SFX_NO_TEMPO = 0;

export function evaluateSfxLoopSeam(
  measurement: LoopMeasurement,
  thresholds: LoopSeamThresholds,
): LoopSeamVerdict {
  return evaluateLoopSeam(measurement, thresholds, SFX_LOOP_SEAM_CRITERIA);
}
