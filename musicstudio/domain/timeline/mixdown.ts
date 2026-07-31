/**
 * The mixdown rules that are decidable without audio (Requirements 28.24–28.29, design
 * §6.1–§6.3).
 *
 * The samples live in Python — `dsp/src/musicstudio_dsp/mixdown.py`, reached through
 * `services/timeline/mixdown-ports.ts` — for the reason `services/effects/ports.ts` gives
 * about effects: design §6.1's algorithm is NumPy over decoded buffers, and no audio
 * crosses into the product layer. What *is* decidable here is everything that is a
 * function of the stored project, and each of those is here rather than in the worker so
 * that there is exactly one answer to it:
 *
 * - **Which clips render** — not restated. `render-target.ts` already implements
 *   Requirements 28.19 and 28.20, mute beating solo. `planMixdown` consumes it.
 * - **The summation order** (Requirement 28.26) — ascending clip id. `render-target.ts`
 *   deliberately preserves project order, because a selection step that reordered would
 *   make Property 12 pass for a reason unrelated to the summation it is about. So the sort
 *   is here, and the worker sorts again on arrival: the ordering is what the property rests
 *   on, and neither side should be able to lose it on its own.
 * - **The length** (Requirement 28.25) — `max(start + playLength)` over the *targets*, so
 *   an excluded clip cannot lengthen the mix.
 * - **The refusal** (Requirement 28.29) — an empty target set, distinguishing "the project
 *   has no clips" from "everything was muted or un-soloed", because a user can act on the
 *   difference.
 * - **The normalisation coefficient** (Requirements 28.24, 28.28) — pure arithmetic over
 *   the peak the worker measured, stated once so the value stored on the asset and the
 *   value in the response cannot be computed two ways.
 *
 * ### Every number here is a bound, not a Quality_Threshold_Set member
 *
 * The test this repository uses (see `bounds.ts` and `domain/sfx/bounds.ts`): does changing
 * the number change what an already-recorded measurement *means*? If so it is a bound.
 *
 * - **0.0001, Requirement 28.26's per-sample tolerance.** It is part of the *definition* of
 *   the commutativity invariant, in the way design §7.1's 0.1 dB is part of the definition
 *   of project equivalence — the clause is unintelligible without it. It is also not a
 *   judgement about audio: nobody hears 0.0001 of full scale, and no asset is admitted or
 *   refused by it. It bounds the numerical error of an implementation, which is a property
 *   of arithmetic rather than of a listener. Requirement 34.1's stated subject is 청감 관련
 *   임계값, and an operator retuning it under 34.4 would be retuning what "the same mix"
 *   means, retroactively, for every mix already stored — exactly what Requirement 34.10
 *   forbids.
 * - **0.99–1.0, Requirement 28.28's normalisation window.** This one is closer to the line,
 *   because it *is* about audio: it says how loud a normalised mix is. It is still a bound,
 *   for the reason 28.28 states it as an instruction rather than as an admission criterion.
 *   No mix is rejected for landing outside the window; the renderer's job is to *put* the
 *   peak inside it. A threshold, in this codebase's sense, is a number a verdict is compared
 *   against (`domain/quality/threshold-name.ts`), and there is no verdict here. Moving the
 *   window would change what every stored `mix` asset's samples *are* — the third test in
 *   `bounds.ts`'s list — rather than which ones are acceptable.
 *
 * Neither is added to `QUALITY_THRESHOLD_NAMES`, so the exhaustive list asserted by
 * `test/unit/bgm/threshold-set.test.ts` is unchanged.
 */

import { renderTargetSet, type ExcludedClip, type RenderTargetSet } from './render-target';
import { clipEndTimeMs, type TimelineClip, type TimelineProject } from './project';

/* ------------------------------------------------------------------ bounds */

/** Requirement 28.25: the permitted error between the computed and produced length. */
export const MIXDOWN_LENGTH_TOLERANCE_MS = 10;

/** Requirement 28.26: the per-sample tolerance between two orderings. */
export const MIXDOWN_SAMPLE_DIFFERENCE_TOLERANCE = 0.0001;

/** Requirement 28.27: how many renders the reproducibility invariant is stated over. */
export const MIXDOWN_REPRODUCIBILITY_RUNS = 3;

/** Requirements 28.24, 28.28: above this peak, and only above it, a coefficient is applied. */
export const MIXDOWN_PEAK_CEILING = 1.0;

/** Requirement 28.28's window for the normalised peak. */
export const NORMALISED_PEAK_MIN = 0.99;
export const NORMALISED_PEAK_MAX = 1.0;

/**
 * Where inside that window normalisation aims — design §6.1's `0.995 / peak`.
 *
 * The midpoint, so `float32` rounding of the scaled samples cannot carry the result out of
 * the window. Mirrors `NORMALISATION_TARGET_PEAK` in `dsp/src/musicstudio_dsp/mixdown.py`.
 */
export const NORMALISATION_TARGET_PEAK = 0.995;

/** Requirement 28.28's reportable attenuation ceiling, in dB. See `peakNormalisation`. */
export const MIXDOWN_ATTENUATION_DB_MAX = 40;

/* ---------------------------------------------------------- length and order */

/**
 * Requirement 28.25: the mix length, from 0 to the latest target clip's end.
 *
 * Over the *targets* only. `0` for an empty set, which never reaches a render because
 * Requirement 28.29 refuses it first — stated here anyway so the function is total.
 */
export function mixdownLengthMs(clips: readonly TimelineClip[]): number {
  return clips.reduce((latest, clip) => Math.max(latest, clipEndTimeMs(clip)), 0);
}

/** Requirement 28.25's tolerance, applied to a produced length. */
export function mixdownLengthWithinTolerance(
  expectedMs: number,
  producedMs: number,
): boolean {
  const error = Math.abs(producedMs - expectedMs);
  // `error <= tol`, not `!(error > tol)`. Both forms appear in this repository and they are
  // *not* interchangeable — the choice turns on which way the predicate points. A **violation**
  // predicate must be written `!(drift <= tol)`, so a NaN counts as a violation instead of
  // slipping through `>`. This is an **admissibility** predicate, so the plain `<=` is the one
  // that makes a NaN produced length inadmissible.
  return error <= MIXDOWN_LENGTH_TOLERANCE_MS;
}

/**
 * The order clips are summed in: ascending clip id (Requirement 28.26).
 *
 * Compared by UTF-16 code unit rather than with `localeCompare`, because a locale-aware
 * comparison depends on the ICU data the process happens to have and Requirement 28.27
 * requires two *workers* to agree. Python's `sorted` on `str` compares by code point;
 * for the identifiers this system generates — UUIDs — the two orders coincide, and the
 * worker re-sorts on arrival anyway, so neither side depends on the other's collation.
 */
export function compareClipIds(left: TimelineClip, right: TimelineClip): number {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** A copy of `clips` in summation order. Does not mutate its argument. */
export function sortClipsForSummation(
  clips: readonly TimelineClip[],
): readonly TimelineClip[] {
  return [...clips].sort(compareClipIds);
}

/* -------------------------------------------------------------- the plan */

/** Requirement 28.29's two ways of having nothing to render. */
export type MixdownRefusalReason =
  /** 믹스다운 요청 시점에 Timeline_Clip이 0개. */
  | 'project_has_no_clips'
  /** 음소거·솔로 상태 적용 후 렌더링 대상 클립이 0개. */
  | 'all_clips_excluded';

export interface MixdownRefusal {
  readonly ok: false;
  readonly reason: MixdownRefusalReason;
  /** Why each clip is out, so the refusal can say which state to change. */
  readonly excluded: readonly ExcludedClip[];
}

/**
 * What a render needs from the project, once Requirements 28.19, 28.20, 28.25 and 28.26
 * have been applied to it.
 */
export interface MixdownPlan {
  readonly ok: true;
  /** The render targets, in summation order. */
  readonly clips: readonly TimelineClip[];
  /** Requirement 28.25's length. */
  readonly lengthMs: number;
  /** Requirement 28.19's `WHILE` condition, as it held when the plan was made. */
  readonly soloActive: boolean;
  readonly excluded: readonly ExcludedClip[];
  /**
   * The distinct assets the mix is derived from, in first-appearance order of the
   * summation. Requirement 19.7 makes a `mix` asset's lineage mandatory and 19.6 caps the
   * direct inputs, so the service needs this list rather than the clip list.
   */
  readonly sourceAssetIds: readonly string[];
}

export type MixdownPlanOutcome = MixdownPlan | MixdownRefusal;

/**
 * Requirements 28.19, 28.20, 28.25, 28.26, 28.29 for one project.
 *
 * Pure: it reads the project and nothing else, so the same project always plans the same
 * way — which is the first half of Requirement 28.27's reproducibility, before any audio
 * is involved.
 */
export function planMixdown(project: TimelineProject): MixdownPlanOutcome {
  const targets: RenderTargetSet = renderTargetSet(project);

  if (targets.clips.length === 0) {
    return {
      ok: false,
      reason: project.clips.length === 0 ? 'project_has_no_clips' : 'all_clips_excluded',
      excluded: targets.excluded,
    };
  }

  const clips = sortClipsForSummation(targets.clips);
  return {
    ok: true,
    clips,
    lengthMs: mixdownLengthMs(clips),
    soloActive: targets.soloActive,
    excluded: targets.excluded,
    sourceAssetIds: [...new Set(clips.map((clip) => clip.assetId))],
  };
}

/* ------------------------------------------------------- peak normalisation */

export interface PeakNormalisation {
  /** Requirement 28.28's 동일한 단일 감쇠 계수. `1` when none was applied. */
  readonly coefficient: number;
  /** Positive dB of attenuation; `0` when none was applied (Requirement 28.24). */
  readonly attenuationDb: number;
  readonly applied: boolean;
  /** See the note below on Requirement 28.28's internal conflict. */
  readonly withinReportableRange: boolean;
}

/**
 * Requirements 28.24 and 28.28: the coefficient for a summed mix with this peak.
 *
 * Mirrors `peak_normalisation` in `dsp/src/musicstudio_dsp/mixdown.py`, and
 * `test/unit/timeline/mixdown.test.ts` pins the two to the same numbers. The worker is the
 * one that applies it; this side recomputes it so that the figure written to the asset's
 * metadata is checked against the worker's rather than taken on trust.
 *
 * ### A single broadband gain, not a limiter
 *
 * 28.28 says 모든 샘플에 동일한 단일 감쇠 계수, and that is also the only choice compatible
 * with Requirement 28.27. A limiter would reach the ceiling with less loss of level and
 * would sound better, but it is not scale-equivariant, so its output depends on the order
 * and grouping of what it is fed — and two renders that must agree bit for bit cannot
 * afford that. `dsp/src/musicstudio_dsp/mastering.py` records the same trade-off for
 * Requirement 30.8's idempotence; the reasoning transfers unchanged.
 *
 * ### Requirement 28.28 asks for two things a loud mix cannot both give
 *
 * The clause requires the normalised peak in [0.99, 1.0] *and* an attenuation of at most
 * 40 dB. 40 dB is a factor of 100, so a summed peak above `0.995 × 100 = 99.5` cannot
 * satisfy both — and that peak is reachable inside Requirement 28's own bounds: a clip at
 * +12 dB on a track at +12 dB is ×15.85, and clips on 32 tracks can sound at once. The
 * amplitude window is the obligation about the audio and is always met; the dB figure is
 * reported with `withinReportableRange: false` rather than clamping the coefficient and
 * leaving the peak above 1.0. **Open question for the spec** — see the task 4.2 report.
 */
export function peakNormalisation(peak: number): PeakNormalisation {
  if (!Number.isFinite(peak) || peak < 0) {
    throw new RangeError(`a summed peak must be a finite non-negative number, got ${String(peak)}`);
  }

  if (peak <= MIXDOWN_PEAK_CEILING) {
    return { coefficient: 1, attenuationDb: 0, applied: false, withinReportableRange: true };
  }

  const coefficient = NORMALISATION_TARGET_PEAK / peak;
  const attenuationDb = -20 * Math.log10(coefficient);
  return {
    coefficient,
    attenuationDb,
    applied: true,
    withinReportableRange: attenuationDb <= MIXDOWN_ATTENUATION_DB_MAX,
  };
}

/** Whether a produced peak sits where Requirement 28.28 requires after attenuation. */
export function normalisedPeakWithinWindow(peak: number): boolean {
  return peak >= NORMALISED_PEAK_MIN && peak <= NORMALISED_PEAK_MAX;
}

/* ------------------------------------------------------------ mix metadata */

/**
 * What a `mix` `Audio_Asset` records about the render that produced it.
 *
 * Requirement 28.28 requires the attenuation "응답과 `mix` Audio_Asset 메타데이터에", so it
 * is a required field of a required type rather than an optional addition — a missing
 * attenuation does not compile, which is the arrangement `domain/bgm/metadata.ts` uses for
 * Requirement 21.15's ten fields.
 *
 * The rest of the fields are the render parameters Requirement 28.27 enumerates, recorded
 * because reproducibility is only checkable against a *stated* parameter set: "the same
 * rendering parameters" is not a claim anyone can verify about a stored asset unless the
 * asset says what they were.
 *
 * There is no `mix_metadata` table yet. Requirement 28.24's asset row is
 * `db/migrations/0003_audio_asset.sql` and its lineage is `0005_lineage.sql` — 0015's
 * header says exactly this and declines to add a mixdown column, because a column there
 * would be a second copy that could disagree with both. So this travels through
 * `MixdownAssetStore` until Library_Service (task 5.1) owns asset metadata storage, which
 * is where `DialogueRenditionStorePort` also waits (see `db/migrations/0012`'s header).
 */
export interface MixAssetMetadata {
  readonly projectId: string;
  /** Requirement 28.28's 감쇠량, in dB. `0` when the mix needed none. */
  readonly attenuationDb: number;
  readonly peakBefore: number;
  readonly peakAfter: number;
  /** Requirement 28.27's parameter list. */
  readonly sampleRate: number;
  readonly channels: number;
  readonly peakNormalisationEnabled: boolean;
  /** Requirement 28.25's computed length, and what the renderer produced. */
  readonly requestedLengthMs: number;
  readonly durationMs: number;
  /** The summation order, so a re-render can be compared against the same one. */
  readonly renderedClipIds: readonly string[];
  /** Requirement 28.19: whether solo narrowed the render. */
  readonly soloActive: boolean;
}

/** Requirement 28.28's field list, for a test that asserts nothing is dropped. */
export const MIX_METADATA_FIELDS = [
  'projectId',
  'attenuationDb',
  'peakBefore',
  'peakAfter',
  'sampleRate',
  'channels',
  'peakNormalisationEnabled',
  'requestedLengthMs',
  'durationMs',
  'renderedClipIds',
  'soloActive',
] as const satisfies readonly (keyof MixAssetMetadata)[];
