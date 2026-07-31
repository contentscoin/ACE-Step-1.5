/**
 * The onset alignment rate (Requirement 23.8) — the acceptance criterion of task 2.6.
 *
 * "23.15가 산출한 Visual_Event_Timeline의 항목 중 신뢰도가 0.50 이상인 각 시각 이벤트에 대해,
 * 해당 이벤트 시각 기준 ±80밀리초 구간 안에 산출 오디오의 온셋이 1개 이상 존재하는 이벤트의
 * 비율을 90% 이상으로 유지한다".
 *
 * Three quantities and one ratio, and the ratio is what the task is judged on. Stated as a
 * pure function over *event times and onset times* — not over audio — so the rule and the
 * measurement are testable apart: `domain/v2a/onset.ts` is checked against synthesised audio,
 * this is checked against generated time sets, and neither can hide a bug in the other.
 *
 * ### The zero-confident-events case
 *
 * Requirement 23.16 sends a clip with no confident event down a different path entirely — an
 * ambience track with no alignment claim — so the rate is *undefined* there rather than 0 or
 * 1. Returning `0 / 0` as a number would make the check fail an asset that 23.16 explicitly
 * permits; returning 1 would claim a measurement that was never taken. So the result is a
 * discriminated union: `no_confident_events` carries no rate, and `isAlignmentSatisfied`
 * treats it as satisfied because 23.8's quantifier ranges over an empty set.
 *
 * ### Why nearest-onset distance rather than a window scan
 *
 * The predicate 23.8 states is "∃ onset within ±tolerance". Reporting the *nearest* onset and
 * its signed offset answers that and also says by how much a failure missed, which is what
 * makes a diagnosis possible: an event whose nearest onset is 85 ms late is a timing problem,
 * one whose nearest onset is 4 seconds away is a missing sound.
 *
 * Both tolerance and rate arrive from the Quality_Threshold_Set (Requirement 34.1) through
 * `domain/quality/v2a-thresholds.ts`. Neither appears as a literal anywhere in this module.
 */

import type { V2aOnsetAlignmentThresholds } from '../quality/v2a-thresholds';

import { confidentEvents, type VisualEvent, type VisualEventTimeline } from './visual-event-timeline';

/** Per-event evidence, so a failure names which events were unaligned and by how much. */
export interface EventAlignment {
  readonly event: VisualEvent;
  readonly aligned: boolean;
  /** Nearest onset time, milliseconds. `null` when the audio has no onsets at all. */
  readonly nearestOnsetMs: number | null;
  /** `nearestOnsetMs − event.timeMs`; positive means the sound is late. `null` as above. */
  readonly offsetMs: number | null;
}

export interface MeasuredAlignment {
  readonly kind: 'measured';
  /** Requirement 23.8's denominator: events at or above the confidence floor. */
  readonly confidentEventCount: number;
  /** Requirement 23.8's numerator. */
  readonly alignedEventCount: number;
  /** Requirement 23.8's ratio, in `[0, 1]`. */
  readonly rate: number;
  readonly satisfied: boolean;
  readonly events: readonly EventAlignment[];
  readonly toleranceMs: number;
  readonly rateMin: number;
  /** Requirement 34.6. */
  readonly thresholdSetVersion: number;
}

export interface UnmeasurableAlignment {
  /** Requirement 23.16: nothing confident to align to, so no rate exists. */
  readonly kind: 'no_confident_events';
  readonly confidentEventCount: 0;
  readonly toleranceMs: number;
  readonly rateMin: number;
  readonly thresholdSetVersion: number;
}

export type AlignmentVerdict = MeasuredAlignment | UnmeasurableAlignment;

export interface AlignmentInput {
  readonly timeline: VisualEventTimeline;
  /** Onset start times from `domain/v2a/onset.ts`, milliseconds. Any order. */
  readonly onsetTimesMs: readonly number[];
}

/** Requirement 23.8 over one timeline and one onset set. */
export function evaluateOnsetAlignment(
  input: AlignmentInput,
  thresholds: V2aOnsetAlignmentThresholds,
): AlignmentVerdict {
  const events = confidentEvents(input.timeline);
  const shape = {
    toleranceMs: thresholds.alignmentToleranceMs,
    rateMin: thresholds.alignmentRateMin,
    thresholdSetVersion: thresholds.version,
  };

  if (events.length === 0) {
    return { kind: 'no_confident_events', confidentEventCount: 0, ...shape };
  }

  const onsets = [...input.onsetTimesMs]
    .filter((time) => Number.isFinite(time))
    .sort((first, second) => first - second);

  const aligned = events.map((event) => alignEvent(event, onsets, thresholds.alignmentToleranceMs));
  const alignedEventCount = aligned.filter((entry) => entry.aligned).length;
  const rate = alignedEventCount / events.length;

  return {
    kind: 'measured',
    confidentEventCount: events.length,
    alignedEventCount,
    rate,
    satisfied: rate >= thresholds.alignmentRateMin,
    events: aligned,
    ...shape,
  };
}

/** The verdict as a single boolean, with 23.16's empty case reading as satisfied. */
export function isAlignmentSatisfied(verdict: AlignmentVerdict): boolean {
  return verdict.kind === 'no_confident_events' ? true : verdict.satisfied;
}

/**
 * Requirement 23.8's ±tolerance test for one event.
 *
 * Inclusive at the boundary: 23.8 says "±80밀리초 구간 **안에**", and an onset exactly 80 ms
 * away is inside a ±80 ms window. Exported so a test can state the boundary case directly.
 */
export function alignEvent(
  event: VisualEvent,
  sortedOnsetTimesMs: readonly number[],
  toleranceMs: number,
): EventAlignment {
  const nearest = nearestOnsetMs(event.timeMs, sortedOnsetTimesMs);
  if (nearest === null) {
    return { event, aligned: false, nearestOnsetMs: null, offsetMs: null };
  }
  const offsetMs = nearest - event.timeMs;
  return {
    event,
    aligned: Math.abs(offsetMs) <= toleranceMs,
    nearestOnsetMs: nearest,
    offsetMs,
  };
}

/**
 * The onset closest to `timeMs`, or `null` when there are none.
 *
 * Binary search over the sorted times rather than a linear scan: a 60-second clip
 * (Requirement 23.3) can hold thousands of onsets and hundreds of events, and the alignment
 * check runs once per variant per job.
 *
 * Ties — an event exactly between two onsets — resolve to the earlier one. Arbitrary but
 * *fixed*, which is what matters: Requirement 23.14 promises reproducibility, and a tie
 * broken by iteration order would make the reported `nearestOnsetMs` depend on nothing.
 */
export function nearestOnsetMs(
  timeMs: number,
  sortedOnsetTimesMs: readonly number[],
): number | null {
  if (sortedOnsetTimesMs.length === 0) return null;

  let low = 0;
  let high = sortedOnsetTimesMs.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((sortedOnsetTimesMs[middle] ?? 0) < timeMs) low = middle + 1;
    else high = middle;
  }

  // `low` is the first onset at or after `timeMs`; its predecessor is the last one before.
  const after = sortedOnsetTimesMs[low];
  const before = low > 0 ? sortedOnsetTimesMs[low - 1] : undefined;
  if (after === undefined) return before ?? null;
  if (before === undefined) return after;

  return timeMs - before <= after - timeMs ? before : after;
}
