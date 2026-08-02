/**
 * The mixdown's stated numbers: its length, and the attenuation it may report.
 *
 * Requirements 28.24, 28.25, 28.28, 28.29. Pure arithmetic over a `Timeline_Project`,
 * kept out of `services/timeline/` so that the length a caller is promised and the length
 * the renderer produces come from one expression rather than two that agree today.
 *
 * The audio itself is rendered in Python (`dsp/src/musicstudio_dsp/mixdown.py`). What is
 * here is only what the product layer must be able to state *before* the worker runs — the
 * expected length, whether there is anything to render at all, and the band a reported
 * attenuation has to fall in for the response and the `mix` asset to be well formed.
 */

import { renderTargetSet, type RenderTargetSet } from './render-target';
import { type TimelineClip, type TimelineProject } from './project';

/** Requirement 28.25's ±10 ms. */
export const MIXDOWN_LENGTH_TOLERANCE_MS = 10;

/**
 * Requirement 28.28's reporting band: `0 초과 40 이하`.
 *
 * A band on the *reported* figure, not a cap on the renderer. The renderer's job is to
 * bring the peak under 1.0 whatever that costs (see `_normalise_peak` in `mixdown.py`);
 * a sum that needs more than 40 dB is a project with hundreds of clips summing in phase,
 * and it is reported honestly and refused here rather than silently clipped there.
 */
export const ATTENUATION_DB_EXCLUSIVE_MIN = 0;
export const ATTENUATION_DB_MAX = 40;

/** Requirement 28.29's 렌더링 대상 부재 사유 코드. */
export type MixdownRejectionReason = 'no_render_target';

/** Requirement 28.13: `원본 자산 길이 - trim_start_ms - trim_end_ms`. */
export function clipPlayDurationMs(clip: TimelineClip): number {
  return clip.sourceDurationMs - clip.trimStartMs - clip.trimEndMs;
}

/** Where a clip stops sounding, on the mixdown's timeline. */
export function clipEndMs(clip: TimelineClip): number {
  return clip.startTimeMs + clipPlayDurationMs(clip);
}

/**
 * Requirement 28.25: 0 to the largest `start_time_ms + 재생 길이` among the targets.
 *
 * Takes the render target clips rather than the project, so that an excluded clip cannot
 * reach the calculation — 28.25 says so explicitly, and the type makes it structural.
 * Zero for an empty set; 28.29 rejects before the length is ever used.
 */
export function mixdownLengthMs(clips: readonly TimelineClip[]): number {
  return clips.reduce((longest, clip) => Math.max(longest, clipEndMs(clip)), 0);
}

/**
 * Requirement 28.28: is this a figure the response and the asset may carry?
 *
 * `0` is *not* in the band. Requirement 28.24 gives the untouched case its own reporting
 * rule — 감쇠량 0데시벨 — so zero travels as "nothing was applied" rather than as a
 * degenerate member of 28.28's range. `isReportableAttenuationDb` accepts both, and is
 * what a response validator wants; `isAppliedAttenuationDb` is 28.28's band alone.
 */
export function isAppliedAttenuationDb(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > ATTENUATION_DB_EXCLUSIVE_MIN &&
    value <= ATTENUATION_DB_MAX
  );
}

export function isReportableAttenuationDb(value: number): boolean {
  return value === 0 || isAppliedAttenuationDb(value);
}

export interface MixdownPlan {
  readonly target: RenderTargetSet;
  /** Requirement 28.25's expected length. `0` when there is nothing to render. */
  readonly lengthMs: number;
  /** Requirement 28.29: set when the render must be refused. */
  readonly rejection: MixdownRejectionReason | null;
}

/**
 * What a mixdown of this project would be, decided before any audio is touched.
 *
 * One function so that the emptiness check of 28.29 and the length of 28.25 are taken
 * from the same target set. Splitting them invites the case where the length is computed
 * over the project's clips while the rejection is decided over the targets.
 */
export function planMixdown(project: TimelineProject): MixdownPlan {
  const target = renderTargetSet(project);
  const lengthMs = mixdownLengthMs(target.clips);

  // 28.29 covers both "the project has no clips" and "solo and mute left none", and gives
  // them one reason code. A length that rounds to nothing is the same refusal: there is
  // no audio to store, and a zero-length `mix` asset would violate Requirement 19.1.
  const rejection: MixdownRejectionReason | null =
    target.clips.length === 0 || lengthMs <= 0 ? 'no_render_target' : null;

  return { target, lengthMs, rejection };
}
