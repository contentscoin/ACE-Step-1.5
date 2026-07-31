/**
 * Bar alignment for loop assets (Requirement 21.17; design §5.3 check 4).
 *
 * A loop that is not a whole number of bars long drifts against anything it is played
 * over, however clean its seam is — which is why 21.17 is one of the four criteria and
 * not a nicety. The rule: the loop's playing time must be an integer multiple, 1 to
 * 64, of one bar computed from the asset's *recorded* BPM and time signature, within
 * the tolerance the Quality_Threshold_Set holds.
 *
 * "Recorded" is load-bearing. The bar length is derived from the metadata stored on
 * the asset (Requirement 21.15), not from what the request asked for, because an
 * engine that chose its own tempo must be judged against the tempo it chose.
 *
 * Pure arithmetic. No thresholds inlined: the tolerance is an argument.
 */

import { BGM_LOOP_BAR_MULTIPLE_MAX, BGM_LOOP_BAR_MULTIPLE_MIN } from './bounds';

/** One bar in milliseconds: `60000 / BPM` per beat, `timeSignature` beats per bar. */
export function barDurationMs(bpm: number, timeSignature: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(timeSignature) || timeSignature <= 0) return Number.POSITIVE_INFINITY;
  return (60_000 / bpm) * timeSignature;
}

export interface BarAlignmentInput {
  readonly durationMs: number;
  readonly bpm: number;
  readonly timeSignature: number;
  /** Requirement 34: read from `loop_bar_alignment_tolerance_ms`. */
  readonly toleranceMs: number;
}

export interface BarAlignment {
  readonly barDurationMs: number;
  /** Nearest whole number of bars. Requirement 21.15 records this. */
  readonly barCount: number;
  /** What the duration would be at exactly `barCount` bars. */
  readonly expectedDurationMs: number;
  /** `|durationMs − expectedDurationMs|`. */
  readonly errorMs: number;
  /** Both the 1–64 multiple range and the tolerance are satisfied. */
  readonly aligned: boolean;
}

/**
 * The nearest whole-bar interpretation of a duration, and whether it holds.
 *
 * Rounding to the *nearest* multiple rather than flooring is what makes the tolerance
 * two-sided, which is what Requirement 21.17's "±25밀리초" says: a loop 5 ms short of
 * eight bars is eight bars with a 5 ms error, not seven bars with a large one.
 *
 * A `barCount` of 0 — a loop shorter than half a bar — is reported as `barCount: 0`
 * and `aligned: false` rather than being coerced up to 1, so the failure names the
 * real condition instead of a large tolerance miss.
 */
export function evaluateBarAlignment(input: BarAlignmentInput): BarAlignment {
  const bar = barDurationMs(input.bpm, input.timeSignature);

  if (!Number.isFinite(bar)) {
    return {
      barDurationMs: bar,
      barCount: 0,
      expectedDurationMs: Number.POSITIVE_INFINITY,
      errorMs: Number.POSITIVE_INFINITY,
      aligned: false,
    };
  }

  const barCount = Math.round(input.durationMs / bar);
  const expectedDurationMs = barCount * bar;
  const errorMs = Math.abs(input.durationMs - expectedDurationMs);
  const withinMultipleRange =
    barCount >= BGM_LOOP_BAR_MULTIPLE_MIN && barCount <= BGM_LOOP_BAR_MULTIPLE_MAX;

  return {
    barDurationMs: bar,
    barCount,
    expectedDurationMs,
    errorMs,
    aligned: withinMultipleRange && errorMs <= input.toleranceMs,
  };
}

/**
 * The nearest duration that *is* bar-aligned, for a caller choosing a target length.
 *
 * Requirement 21.17 constrains the produced asset, and the surest way to satisfy it is
 * to ask for a length that already is a whole number of bars. The multiple is clamped
 * into 1–64 so a request outside the range comes back at the nearest legal loop rather
 * than as an error the caller cannot act on.
 */
export function nearestAlignedDurationMs(
  targetMs: number,
  bpm: number,
  timeSignature: number,
): number {
  const bar = barDurationMs(bpm, timeSignature);
  if (!Number.isFinite(bar)) return targetMs;

  const bars = Math.min(
    BGM_LOOP_BAR_MULTIPLE_MAX,
    Math.max(BGM_LOOP_BAR_MULTIPLE_MIN, Math.round(targetMs / bar)),
  );
  return bars * bar;
}
