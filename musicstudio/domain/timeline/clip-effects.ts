/**
 * Clip effects in a mixdown, and the delay/reverb tail policy (Requirements 29.31, 29.32;
 * design §6.3).
 *
 * Requirement 29.31 states the stage order and Requirement 29.32 states the tail ceiling, and
 * the two together describe a single decision that has to be made *twice*, differently,
 * depending on where the processed audio is going. That decision is what this module is:
 *
 * | destination | what happens to the tail | stated by |
 * |---|---|---|
 * | inside a mixdown | cut at the clip's **play length** | 29.31, design §6.3 |
 * | an independent `Generation_Version` | **preserved**, up to original + 10 000 ms | 29.32, design §6.3 |
 *
 * Design §6.3 is explicit that these are the only two answers: "이펙트 테일은 독립
 * Generation_Version 저장 시에만 보존 (최대 +10000ms)". So a mixdown never holds a tail, and the
 * 10-second allowance is not a mixdown quantity at all.
 *
 * ### Why the tail cannot be kept in a mix, stated as more than "the spec says so"
 *
 * Requirement 28.25 fixes the mix length at `max(start_time_ms + 재생 길이)` over the render
 * targets, and 28.13 fixes 재생 길이 at `source − trim_start − trim_end`. Neither mentions
 * effects. A clip whose reverb rang on past its play length would therefore either lengthen the
 * mix past the length 28.25 computes — breaking the ±10 ms check in
 * `services/timeline/mixdown-renderer.ts` — or bleed over whatever the user placed after it on
 * the timeline. The truncation is not a limitation of the renderer; it is what makes the clip's
 * placement mean what the timeline shows.
 *
 * ### Nothing here is a new number
 *
 * The ceiling is `EFFECT_TAIL_ALLOWANCE_MS` from `domain/effects/registry.ts`, declared by task
 * 3.2 for Requirement 29.32 and mirrored in `dsp/src/musicstudio_dsp/effect_registry.json`. It
 * is re-exported, not re-declared: two declarations of 10 000 would eventually be corrected in
 * one place only, and the registry parity test already pins the Python side to the registry.
 *
 * It is a **bound**, not a `Quality_Threshold_Set` member, and it was already classified that
 * way where it is declared. The repository's test (see `bounds.ts`): does changing the number
 * change what an already-recorded measurement *means*? It does — every stored
 * `Generation_Version` produced by a delay or reverb chain has a duration that this number
 * bounded, so moving it would retroactively change which of them were admissible, which is
 * what Requirement 34.10 forbids. It is also not a perceptual judgement: no audio is accepted
 * or rejected for sounding a certain way, the tail is simply cut. `QUALITY_THRESHOLD_NAMES` is
 * therefore unchanged, and the exhaustive list asserted by
 * `test/unit/bgm/threshold-set.test.ts` needs no edit.
 *
 * ### What this module does not do
 *
 * It does not *apply* anything. The samples are processed by
 * `dsp/src/musicstudio_dsp/effects.py`'s `apply_chain` — task 3.2's, including the padding that
 * lets a tail develop and the trim that caps it — and the clip-level policy is wired in
 * `dsp/src/musicstudio_dsp/clip_effects.py`, which is this module's counterpart on the Python
 * side. It also does not decide the version-side length verdict: `lengthViolationFor` in
 * `services/effects/effects-service.ts` already does, and it is reused rather than restated.
 */

import { chainMayExtendTail } from '../effects/chain';
import { EFFECT_TAIL_ALLOWANCE_MS } from '../effects/registry';

import { clipPlayLengthMs, type TimelineClip } from './project';

/**
 * Requirement 29.32's tail allowance, re-exported from where Requirement 29 declares it.
 *
 * Present here so a reader of the timeline layer finds the number that governs a clip's tail
 * without having to know it lives in the effects registry, and so this module has one import
 * to change if Requirement 29.32 is ever restated.
 */
export { EFFECT_TAIL_ALLOWANCE_MS };

/** Where a clip's processed audio is going, which is what decides the tail. */
export type ClipEffectDestination =
  /** Summed into a mixdown (Requirement 29.31). */
  | 'mixdown'
  /** Stored as an independent `Generation_Version` (Requirement 29.32). */
  | 'generation_version';

/**
 * Design §5.6's per-clip stages, in Requirement 29.31's order.
 *
 * Declared as data because 29.31 states the order as part of the obligation — "트림이 적용된
 * 클립 오디오에 지정된 Effect_Chain을 적용하고 그 결과를 해당 클립의 재생 길이로 잘라낸 뒤
 * 클립 게인과 페이드를 적용한 오디오를 합산한다" — and an order stated in a comment is an order
 * a refactor can quietly change. `test/unit/timeline/clip-effects.test.ts` asserts this list
 * against the stage order `dsp/src/musicstudio_dsp/mixdown.py` actually implements.
 *
 * The two facts worth reading off it: **effects come after the trim**, so a chain never hears
 * audio the user trimmed away; and **the truncation comes before the gain and the fades**, so
 * the fade-out lands on the clip's last audible millisecond rather than somewhere inside a
 * reverb tail that is about to be discarded.
 */
export const CLIP_EFFECT_STAGES = [
  'load',
  'trim',
  'effects',
  'truncate_to_play_length',
  'gain',
  'fade',
  'place',
] as const;

export type ClipEffectStage = (typeof CLIP_EFFECT_STAGES)[number];

/** Requirement 29.31: the index at which the chain is applied, and the cut that follows it. */
export const CLIP_EFFECT_STAGE_INDEX = CLIP_EFFECT_STAGES.indexOf('effects');
export const CLIP_TRUNCATE_STAGE_INDEX = CLIP_EFFECT_STAGES.indexOf('truncate_to_play_length');

/**
 * The length a clip's processed audio is cut to, in milliseconds, for a given destination.
 *
 * `originalLengthMs` is the length the chain was given: the clip's play length in a mixdown, the
 * source version's duration for a `Generation_Version`.
 */
export function tailCeilingMs(
  destination: ClipEffectDestination,
  originalLengthMs: number,
): number {
  // Requirement 29.31 and design §6.3: no tail survives a mix.
  if (destination === 'mixdown') return originalLengthMs;
  // Requirement 29.32: the tail is preserved, and capped.
  return originalLengthMs + EFFECT_TAIL_ALLOWANCE_MS;
}

/** Requirement 29.31: the length a clip contributes to a mix, chain or no chain. */
export function clipMixdownLengthMs(clip: TimelineClip): number {
  return clipPlayLengthMs(clip);
}

/** Whether this clip's chain can produce a tail at all (Requirements 29.30, 29.32). */
export function clipChainMayExtendTail(clip: TimelineClip): boolean {
  return clip.effectChain !== null && chainMayExtendTail(clip.effectChain);
}

/**
 * What happens to one clip's chain in one destination.
 *
 * A record rather than three loose functions, because the three answers are only meaningful
 * together: "the tail is discarded" is a statement about a ceiling, and a caller that read one
 * without the other could cut at the wrong length.
 */
export interface ClipEffectDisposition {
  readonly clipId: string;
  readonly destination: ClipEffectDestination;
  /** `false` for a clip with no chain: Requirement 29.31's `WHERE` does not hold. */
  readonly chainApplied: boolean;
  /** Requirements 29.30, 29.32: could this chain lengthen the audio? */
  readonly mayExtendTail: boolean;
  /** The length the processed audio is cut to. */
  readonly ceilingMs: number;
  /**
   * Whether a tail this chain produced is kept.
   *
   * True only for `generation_version` with a tail-extending chain — design §6.3's "독립
   * Generation_Version 저장 시에만".
   */
  readonly tailPreserved: boolean;
}

export function clipEffectDisposition(
  clip: TimelineClip,
  destination: ClipEffectDestination,
  sourceLengthMs: number = clipPlayLengthMs(clip),
): ClipEffectDisposition {
  const mayExtendTail = clipChainMayExtendTail(clip);
  return {
    clipId: clip.id,
    destination,
    chainApplied: clip.effectChain !== null,
    mayExtendTail,
    ceilingMs: tailCeilingMs(destination, sourceLengthMs),
    tailPreserved: destination === 'generation_version' && mayExtendTail,
  };
}

/* ------------------------------------------------- mixdown-wide consistency */

/**
 * Requirement 29.31 over a whole render target set: which clips carry a chain.
 *
 * The clip ids, in the order they were given — which is the summation order by the time this is
 * called (see `domain/timeline/mixdown.ts`) — so the answer can be compared element by element
 * against what the worker reports it processed. That comparison is the "믹스다운 내 클립 이펙트
 * 정합성" of task 4.3's brief: a worker that dropped a chain returns audio that looks entirely
 * plausible, and the only way to notice is to check the set.
 */
export function clipsWithEffectChains(clips: readonly TimelineClip[]): readonly string[] {
  return clips.filter((clip) => clip.effectChain !== null).map((clip) => clip.id);
}

/** Whether any clip in the set carries a chain, i.e. whether a processor is needed at all. */
export function requiresEffectProcessor(clips: readonly TimelineClip[]): boolean {
  return clips.some((clip) => clip.effectChain !== null);
}

/** The subset whose chains can ring on past the clip, i.e. those the cut actually bites on. */
export function clipsWithTailExtendingChains(
  clips: readonly TimelineClip[],
): readonly string[] {
  return clips.filter((clip) => clipChainMayExtendTail(clip)).map((clip) => clip.id);
}

export type ClipEffectConsistencyCode =
  /** A clip carrying a chain was not processed. */
  | 'clip_effects_not_applied'
  /** A clip with no chain was processed anyway. */
  | 'clip_effects_applied_unexpectedly';

export interface ClipEffectConsistencyBreach {
  readonly code: ClipEffectConsistencyCode;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
  /** The clip ids the two sets disagree about, so the report names them. */
  readonly clipIds: readonly string[];
}

/**
 * Requirement 29.31's consistency check for one render: did the renderer process exactly the
 * clips that carry a chain?
 *
 * Set comparison rather than element-wise: the report is about *membership*, and the worker
 * sorts its own output, so demanding an order here would fail on a difference that does not
 * matter. The summation *order* is checked separately and strictly, in
 * `services/timeline/mixdown-renderer.ts`, because Requirements 28.26 and 28.27 rest on it.
 *
 * Both directions are checked. A renderer that processed a chain-less clip is as wrong as one
 * that skipped a chain — it means the payload and the plan disagree about which clip is which,
 * and the samples would be somebody else's.
 */
export function clipEffectConsistency(
  planned: readonly TimelineClip[],
  processedClipIds: readonly string[],
): ClipEffectConsistencyBreach | null {
  const expected = clipsWithEffectChains(planned);
  const expectedSet = new Set(expected);
  const actualSet = new Set(processedClipIds);

  const missing = expected.filter((id) => !actualSet.has(id));
  if (missing.length > 0) {
    return {
      code: 'clip_effects_not_applied',
      expected,
      actual: [...processedClipIds],
      clipIds: missing,
    };
  }

  const unexpected = [...actualSet].filter((id) => !expectedSet.has(id));
  if (unexpected.length > 0) {
    return {
      code: 'clip_effects_applied_unexpectedly',
      expected,
      actual: [...processedClipIds],
      clipIds: unexpected,
    };
  }

  return null;
}

/**
 * Requirement 29.31 as an invariant over a produced mix: no clip lengthened it.
 *
 * A separate check from the length tolerance of Requirement 28.25, and a weaker one — it is the
 * same arithmetic, restated over the clips that could plausibly have broken it, so that a
 * failure says *why* the mix is long rather than only that it is. Returns the clip ids whose
 * chains could have extended past their play length; when the produced length is within
 * tolerance and this list is non-empty, the truncation demonstrably happened.
 */
export function tailTruncationWitness(clips: readonly TimelineClip[]): {
  readonly clipIds: readonly string[];
  /** What the mix would have been long by, had no tail been cut, in the worst case. */
  readonly worstCaseOvershootMs: number;
} {
  const clipIds = clipsWithTailExtendingChains(clips);
  return {
    clipIds,
    worstCaseOvershootMs: clipIds.length === 0 ? 0 : EFFECT_TAIL_ALLOWANCE_MS,
  };
}
