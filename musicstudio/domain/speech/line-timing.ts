/**
 * Per-line timings for a dialogue asset, and what re-synthesising one line does to them
 * (Requirements 25.14, 25.15, 25.16, 25.17, 25.20; Requirement 27.14).
 *
 * This is the subtle module of task 2.7, so the model is stated in full before any code.
 *
 * ### The layout, and why timings are *derived* rather than stored independently
 *
 * A dialogue asset's audio is the 50 ms cross-fade join of one audio piece per line. What is
 * stored is therefore a **layout** — each line's synthesised duration plus the overlap
 * actually consumed at each seam — and the timings of 25.14 are computed from it by
 * `dialogueTimingOf`.
 *
 * That is the whole trick behind 25.20. Line `i`'s start is a function of `d₀…d_{i−1}` and
 * `o₀…o_{i−1}` and of nothing else, so changing `d_k` for `k ≥ i` **cannot** move it. The
 * invariant "re-synthesising a line leaves every preceding line's timings unchanged" is not a
 * rule this module remembers to obey; it is a consequence of the arithmetic being prefix-only.
 * Storing each line's start and end as independent mutable fields and shifting them on
 * re-synthesis would satisfy 25.20 only for as long as every future edit path remembered to.
 *
 * ### How a line's interval relates to the cross-fade
 *
 * The join consumes one overlap per seam, so the pieces sum to more than the audio. The
 * reported intervals partition the timeline with no overlap and no gap:
 *
 * ```
 *   start(0) = 0
 *   end(i)   = start(i) + dᵢ − oᵢ        (oᵢ = overlap at the seam after line i; 0 for the last)
 *   start(i+1) = end(i)
 * ```
 *
 * **The cross-fade region is attributed to the incoming line.** `start(i+1)` is therefore the
 * instant line `i+1`'s samples first contribute to the mix, which is the natural reading of
 * 25.14's "대응 오디오 구간의 시작 시각". The alternative — splitting each fade at its midpoint —
 * would put every boundary 25 ms away from any event an editor can hear.
 *
 * This is also how 25.17 and the 50 ms cross-fade of 25.11/25.15 are made consistent with each
 * other. The *audio* of two adjacent lines overlaps by 50 ms, by construction; the *reported
 * intervals* do not overlap, because a boundary is a point rather than a region. Reporting
 * intervals that overlapped by the fade length would satisfy 25.15 while breaking 25.17, and
 * the two criteria are both non-negotiable.
 *
 * ### Integer milliseconds
 *
 * 25.14 requires integers. Boundaries are computed exactly and rounded once, and each rounded
 * boundary is then pushed to at least one millisecond past its predecessor so that 25.17's
 * `start < end` survives a line whose exclusive duration rounds to zero. The nudge reads only
 * the *preceding* boundary, so the prefix-only property above is preserved — which matters,
 * because a nudge that looked ahead would reintroduce exactly the coupling 25.20 forbids.
 *
 * ### Gaps
 *
 * 25.16 requires "인접 행 사이의 간격 길이" to be preserved. In this layout the intervals are
 * contiguous, so every gap is zero and preservation is immediate. It is still exposed as
 * `gapsOf` and asserted as a property rather than argued in a comment, so a future layout that
 * inserted inter-line pauses could not break the criterion silently.
 */

import {
  DIALOGUE_LINE_COUNT_MAX,
  DIALOGUE_LINE_COUNT_MIN,
  DIALOGUE_LINE_LENGTH_MAX,
  DIALOGUE_LINE_LENGTH_MIN,
  LINE_LENGTH_CHANGE_THRESHOLD_MS,
} from './bounds';

/** One line's synthesised audio, before the join consumes any of it. */
export interface DialogueLineSegment {
  /** Requirement 25.14: 0부터 시작하는 연속 정수. */
  readonly lineIndex: number;
  readonly text: string;
  /** The piece's own length in milliseconds, as measured on the synthesised audio. */
  readonly durationMs: number;
}

export interface DialogueLayout {
  readonly segments: readonly DialogueLineSegment[];
  /**
   * Overlap consumed at each seam, in milliseconds. Length is `segments.length − 1`.
   *
   * The *consumed* overlap rather than the nominal 50 ms, because `crossfadeJoin` clamps it to
   * the shorter neighbour and a one-character line (25.14 permits one) can be shorter than the
   * fade. Taking the clamped value means the derived timings describe the audio that exists
   * rather than the audio that was intended.
   */
  readonly overlapsMs: readonly number[];
}

/** Requirement 25.14's stored record for one line. */
export interface SpeechLineTiming {
  readonly lineIndex: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface DialogueTiming {
  readonly lines: readonly SpeechLineTiming[];
  /** Requirement 25.16: the whole asset's length, in integer milliseconds. */
  readonly totalDurationMs: number;
}

export const EMPTY_DIALOGUE_TIMING: DialogueTiming = { lines: [], totalDurationMs: 0 };

/** Total audio length the layout produces, in exact milliseconds. */
export function layoutDurationMs(layout: DialogueLayout): number {
  const summed = layout.segments.reduce((total, segment) => total + segment.durationMs, 0);
  const consumed = layout.overlapsMs.reduce((total, overlap) => total + overlap, 0);
  return Math.max(0, summed - consumed);
}

/**
 * Requirements 25.14, 25.17, 27.14 — the timings, derived from the layout.
 *
 * `measuredTotalMs` lets a caller pin the total to the length actually measured on the joined
 * audio instead of to the layout's arithmetic; they agree to within frame rounding, and taking
 * the measurement when there is one is what keeps 25.17's `end ≤ total` true of the real file.
 */
export function dialogueTimingOf(
  layout: DialogueLayout,
  measuredTotalMs?: number,
): DialogueTiming {
  const lines: SpeechLineTiming[] = [];
  let exactStart = 0;
  let previousEnd = 0;

  for (let index = 0; index < layout.segments.length; index += 1) {
    const segment = layout.segments[index];
    if (segment === undefined) continue;
    const overlap = index === layout.segments.length - 1 ? 0 : (layout.overlapsMs[index] ?? 0);
    const exclusive = Math.max(0, segment.durationMs - overlap);
    const exactEnd = exactStart + exclusive;

    const startMs = index === 0 ? 0 : previousEnd;
    // At least one millisecond long, reading only the preceding boundary. See the module
    // comment on why the nudge must not look ahead.
    const endMs = Math.max(startMs + 1, Math.round(exactEnd));

    lines.push({ lineIndex: segment.lineIndex, text: segment.text, startMs, endMs });
    exactStart = exactEnd;
    previousEnd = endMs;
  }

  const arithmeticTotal = Math.round(layoutDurationMs(layout));
  const total = measuredTotalMs === undefined ? arithmeticTotal : Math.round(measuredTotalMs);

  // A measured total shorter than the arithmetic one — frame rounding, at most a sample or two —
  // would leave the final line's end past the end of the file, which 25.17 forbids. The final line
  // is clamped rather than the total being raised, because the audio is the authority on its own
  // length. Only the *last* line can be affected, so the prefix-only property above survives.
  const last = lines[lines.length - 1];
  if (last !== undefined && total < last.endMs) {
    const clampedEnd = Math.max(last.startMs + 1, total);
    lines[lines.length - 1] = { ...last, endMs: clampedEnd };
    previousEnd = clampedEnd;
  }

  return { lines, totalDurationMs: Math.max(total, previousEnd) };
}

/** Requirement 25.16: the gap after each line, in milliseconds. Zero in this layout. */
export function gapsOf(timing: DialogueTiming): readonly number[] {
  const gaps: number[] = [];
  for (let index = 1; index < timing.lines.length; index += 1) {
    const previous = timing.lines[index - 1];
    const current = timing.lines[index];
    if (previous === undefined || current === undefined) continue;
    gaps.push(current.startMs - previous.endMs);
  }
  return gaps;
}

export type DialogueTimingDefect =
  | { readonly kind: 'negative_start'; readonly lineIndex: number }
  | { readonly kind: 'non_positive_span'; readonly lineIndex: number }
  | { readonly kind: 'end_past_total'; readonly lineIndex: number }
  | { readonly kind: 'out_of_order'; readonly lineIndex: number }
  | { readonly kind: 'overlapping'; readonly lineIndex: number }
  | { readonly kind: 'non_integer'; readonly lineIndex: number }
  | { readonly kind: 'line_index_not_sequential'; readonly lineIndex: number }
  | { readonly kind: 'line_count_out_of_range'; readonly count: number }
  | { readonly kind: 'line_length_out_of_range'; readonly lineIndex: number };

/**
 * Requirements 25.14 and 25.17 as one total predicate.
 *
 * Every clause of 25.17 plus 25.14's structural rules — sequential 0-based indices, integer
 * milliseconds, 1–1000 lines, 1–1000 characters per line — because a timing that satisfies
 * 25.17 while carrying a blank line or a fractional millisecond is still not a thing 25.14
 * permits to be stored.
 */
export function dialogueTimingDefects(timing: DialogueTiming): readonly DialogueTimingDefect[] {
  const defects: DialogueTimingDefect[] = [];
  const count = timing.lines.length;

  if (count < DIALOGUE_LINE_COUNT_MIN || count > DIALOGUE_LINE_COUNT_MAX) {
    defects.push({ kind: 'line_count_out_of_range', count });
  }

  timing.lines.forEach((line, position) => {
    if (line.lineIndex !== position) {
      defects.push({ kind: 'line_index_not_sequential', lineIndex: line.lineIndex });
    }
    if (
      line.text.length < DIALOGUE_LINE_LENGTH_MIN ||
      line.text.length > DIALOGUE_LINE_LENGTH_MAX
    ) {
      defects.push({ kind: 'line_length_out_of_range', lineIndex: position });
    }
    if (!Number.isInteger(line.startMs) || !Number.isInteger(line.endMs)) {
      defects.push({ kind: 'non_integer', lineIndex: position });
    }
    if (line.startMs < 0) defects.push({ kind: 'negative_start', lineIndex: position });
    if (!(line.startMs < line.endMs)) {
      defects.push({ kind: 'non_positive_span', lineIndex: position });
    }
    if (line.endMs > timing.totalDurationMs) {
      defects.push({ kind: 'end_past_total', lineIndex: position });
    }

    const previous = timing.lines[position - 1];
    if (previous === undefined) return;
    if (line.startMs < previous.startMs) defects.push({ kind: 'out_of_order', lineIndex: position });
    if (line.startMs < previous.endMs) defects.push({ kind: 'overlapping', lineIndex: position });
  });

  return defects;
}

export function isValidDialogueTiming(timing: DialogueTiming): boolean {
  return dialogueTimingDefects(timing).length === 0;
}

/** Requirement 25.21's range: the line indices a re-synthesis request may name. */
export function isAddressableLineIndex(timing: DialogueTiming, lineIndex: number): boolean {
  return Number.isInteger(lineIndex) && lineIndex >= 0 && lineIndex < timing.lines.length;
}

export interface ResynthesisRetiming {
  /**
   * False when the new audio's length is within 25.16's 1 ms threshold of the old.
   *
   * Nothing moves in that case — not the target line's end either. 25.16 conditions the whole
   * re-timing on a difference of at least 1 ms, so a sub-millisecond change leaves the stored
   * timings byte-identical rather than nudging them by a rounding artefact.
   */
  readonly retimed: boolean;
  readonly layout: DialogueLayout;
  readonly timing: DialogueTiming;
  /** 재합성 길이 − 재생성 이전 길이, in exact milliseconds. */
  readonly deltaMs: number;
}

/**
 * Requirements 25.15, 25.16, 25.20 — one line's duration changes; everything follows.
 *
 * The whole implementation is "replace `d_i`, re-derive". The three criteria then hold for
 * reasons rather than by construction of special cases:
 *
 * - **25.20** — every earlier line's start and end depend only on `d₀…d_{i−1}`, untouched.
 * - **25.16** — every later boundary is the earlier ones plus the new duration, so each moves
 *   by exactly the delta, and the total moves by the delta as well.
 * - **25.16's gaps** — the layout is contiguous before and after, so every gap stays zero.
 *
 * `overlapsMs` is accepted because `crossfadeJoin` may consume a different overlap at the two
 * seams around a line that changed length past the 50 ms fade; passing the overlaps measured
 * on the *new* join keeps the timings describing the new audio. Omitted, the existing overlaps
 * are kept, which is the case whenever both the old and the new piece are longer than a fade.
 */
export function retimeAfterResynthesis(
  layout: DialogueLayout,
  lineIndex: number,
  newDurationMs: number,
  overlapsMs?: readonly number[],
): ResynthesisRetiming {
  const target = layout.segments[lineIndex];
  if (target === undefined) {
    return {
      retimed: false,
      layout,
      timing: dialogueTimingOf(layout),
      deltaMs: 0,
    };
  }

  const deltaMs = newDurationMs - target.durationMs;
  if (Math.abs(deltaMs) < LINE_LENGTH_CHANGE_THRESHOLD_MS) {
    return { retimed: false, layout, timing: dialogueTimingOf(layout), deltaMs };
  }

  const next: DialogueLayout = {
    segments: layout.segments.map((segment, position) =>
      position === lineIndex ? { ...segment, durationMs: newDurationMs } : segment,
    ),
    overlapsMs: overlapsMs === undefined ? layout.overlapsMs : [...overlapsMs],
  };

  return { retimed: true, layout: next, timing: dialogueTimingOf(next), deltaMs };
}

/** The layout a stored timing implies, for a caller that holds only the timing. */
export function layoutOf(timing: DialogueTiming, overlapsMs: readonly number[]): DialogueLayout {
  return {
    segments: timing.lines.map((line, position) => ({
      lineIndex: line.lineIndex,
      text: line.text,
      // The exclusive span plus the overlap the join consumed after it: the inverse of
      // `dialogueTimingOf`'s subtraction, so a round trip through the two is the identity.
      durationMs:
        line.endMs -
        line.startMs +
        (position === timing.lines.length - 1 ? 0 : (overlapsMs[position] ?? 0)),
    })),
    overlapsMs: [...overlapsMs],
  };
}
