/**
 * Visual_Event_Timeline (Requirements 23.15, 23.16).
 *
 * 23.15: "검출된 각 시각 이벤트의 밀리초 단위 시각, 0.00 이상 1.00 이하 신뢰도, 범주 이름을
 * 시각 오름차순으로 담은 Visual_Event_Timeline을 Audio_Asset 메타데이터로 저장하고 사용자에게
 * 반환한다". 23.16 adds the case where nothing confident was found.
 *
 * Three things are enforced here and nowhere else, so the timeline that reaches storage and
 * the timeline that reaches the user are the same object with the same guarantees:
 *
 * 1. **Ascending by time.** A stable sort, so two events at the same millisecond keep the
 *    order the detector reported them in — the detector may have ranked them, and re-ranking
 *    by an unrelated key would discard that.
 * 2. **Confidence inside `[0.00, 1.00]`.** Clamped, not rejected, for the reason
 *    `normalizeAlignmentScore` is: 23.15 is a statement about what is *stored*, and a
 *    detector reporting 1.0000000002 has found a certain event, not a malformed one.
 * 3. **A detection status.** 23.16 requires a status value saying no visual event was found,
 *    and it has to be derived from the same confidence floor the alignment rule uses or the
 *    two could disagree — an asset could be marked "events detected" and then be exempted
 *    from alignment, or the reverse.
 *
 * The category name is free text from the detector, trimmed and defaulted rather than
 * validated against a list. Requirement 23.15 asks for "범주 이름" without enumerating the
 * categories, and inventing a closed vocabulary here would reject events a future detector
 * legitimately reports.
 */

import { V2A_CONFIDENCE_MAX, V2A_CONFIDENCE_MIN } from './bounds';

/** Category recorded when the detector names none. */
export const V2A_UNCATEGORISED_EVENT = 'uncategorised';

/** One entry of the timeline (Requirement 23.15). */
export interface VisualEvent {
  /** Requirement 23.15: milliseconds from the start of the clip. */
  readonly timeMs: number;
  /** Requirement 23.15: `[0.00, 1.00]`. */
  readonly confidence: number;
  /** Requirement 23.15: the detector's category name. */
  readonly category: string;
}

/**
 * Requirement 23.16's status value.
 *
 * Two members, because 23.16 distinguishes exactly two cases: at least one event at or above
 * the confidence floor, or none. An empty timeline and a timeline of nothing but low-confidence
 * events are the *same* case as far as 23.16 is concerned — neither yields anything to align
 * to — so they share the status rather than being told apart by list length, which a client
 * would otherwise have to re-derive.
 */
export const V2A_DETECTION_STATUSES = ['events_detected', 'no_visual_events_detected'] as const;

export type V2aDetectionStatus = (typeof V2A_DETECTION_STATUSES)[number];

export interface VisualEventTimeline {
  /** Requirement 23.15: ascending by `timeMs`, confidences already clamped. */
  readonly events: readonly VisualEvent[];
  /** Requirement 23.16. */
  readonly status: V2aDetectionStatus;
  /** The floor `status` and the alignment rule were both taken against (23.8, 23.16). */
  readonly confidenceMin: number;
  /** How many events sit at or above `confidenceMin`. */
  readonly confidentEventCount: number;
}

/** Requirement 23.15's clamp. Anything unusable becomes the floor, never `NaN`. */
export function normaliseConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return V2A_CONFIDENCE_MIN;
  return Math.min(V2A_CONFIDENCE_MAX, Math.max(V2A_CONFIDENCE_MIN, raw));
}

/**
 * Requirements 23.15 and 23.16 in one pure step.
 *
 * `confidenceMin` is a parameter, never a literal: it is the Quality_Threshold_Set member
 * `v2a_visual_event_confidence_min` (Requirement 34.1), read through
 * `domain/quality/v2a-thresholds.ts`.
 *
 * Events with a non-finite time are dropped rather than sorted to an arbitrary place. An
 * event whose time is unknown cannot be aligned to and cannot be shown on a timeline, and
 * keeping it would make the ascending-order invariant unstatable.
 */
export function buildVisualEventTimeline(
  detected: readonly VisualEvent[],
  confidenceMin: number,
): VisualEventTimeline {
  const events = detected
    .filter((event) => Number.isFinite(event.timeMs))
    .map((event) => ({
      timeMs: event.timeMs,
      confidence: normaliseConfidence(event.confidence),
      category: normaliseCategory(event.category),
    }))
    // Stable in every JavaScript engine since ES2019, which is what preserves the
    // detector's own order among simultaneous events.
    .sort((first, second) => first.timeMs - second.timeMs);

  const confidentEventCount = events.filter((event) => event.confidence >= confidenceMin).length;

  return {
    events,
    status: confidentEventCount > 0 ? 'events_detected' : 'no_visual_events_detected',
    confidenceMin,
    confidentEventCount,
  };
}

/** The events Requirement 23.8's alignment rate is computed over. */
export function confidentEvents(timeline: VisualEventTimeline): readonly VisualEvent[] {
  return timeline.events.filter((event) => event.confidence >= timeline.confidenceMin);
}

/** Requirement 23.15's ordering invariant, checkable on any produced timeline. */
export function isAscendingByTime(events: readonly VisualEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if ((events[index]?.timeMs ?? 0) < (events[index - 1]?.timeMs ?? 0)) return false;
  }
  return true;
}

/** Requirement 23.15's confidence range invariant. */
export function hasNormalisedConfidences(events: readonly VisualEvent[]): boolean {
  return events.every(
    (event) =>
      Number.isFinite(event.confidence) &&
      event.confidence >= V2A_CONFIDENCE_MIN &&
      event.confidence <= V2A_CONFIDENCE_MAX,
  );
}

/** Requirement 23.16: whether the ambience path applies. */
export function requiresAmbienceFallback(timeline: VisualEventTimeline): boolean {
  return timeline.status === 'no_visual_events_detected';
}

function normaliseCategory(category: unknown): string {
  if (typeof category !== 'string') return V2A_UNCATEGORISED_EVENT;
  const trimmed = category.trim();
  return trimmed.length === 0 ? V2A_UNCATEGORISED_EVENT : trimmed;
}
