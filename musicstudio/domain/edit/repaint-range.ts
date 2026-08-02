/**
 * The repaint interval (Requirements 7.3, 7.4, 7.5).
 *
 * Three criteria, and the distinction between the last two is the whole point of
 * this module:
 *
 * - **7.4 is a rejection.** A start at or after the end describes no interval at
 *   all, so there is nothing to repaint and no repair that would not be a guess at
 *   what the user meant.
 * - **7.5 is not a rejection.** An end past the source length describes a real
 *   interval whose tail happens to run off the end of the audio. The request
 *   proceeds with the end moved to the source length, and the response says so.
 *
 * The order matters: 7.4 is checked against the values the caller supplied, *before*
 * any clamping, so `{ start: 30, end: 20 }` on a 25-second source is an ordering
 * violation rather than a silently clamped empty interval.
 */

import { editOrderingViolation, editRangeViolation, type EditFieldViolation } from './violation';

/** Requirement 7.5's report: the field moved, what was asked, what will be used. */
export interface RepaintAdjustment {
  readonly field: 'repaintEndSeconds';
  readonly requested: number;
  readonly applied: number;
  readonly reason: 'clamped_to_source_length';
}

export interface RepaintRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export type RepaintRangeResolution =
  | {
      readonly kind: 'resolved';
      readonly range: RepaintRange;
      /** Present only when Requirement 7.5 moved the end. */
      readonly adjustment?: RepaintAdjustment;
    }
  | { readonly kind: 'invalid'; readonly violations: readonly EditFieldViolation[] };

export interface RepaintRangeInput {
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Length of the audio being repainted, from its validated descriptor. */
  readonly sourceDurationSeconds: number;
}

export function resolveRepaintRange(input: RepaintRangeInput): RepaintRangeResolution {
  const violations: EditFieldViolation[] = [];
  const { startSeconds, endSeconds, sourceDurationSeconds } = input;

  // A negative or non-finite bound is neither 7.4's ordering problem nor 7.5's
  // overrun; it is simply not a time, and clamping it would invent one.
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    violations.push(
      editRangeViolation('repaintStartSeconds', startSeconds, 0, sourceDurationSeconds),
    );
  }
  if (!Number.isFinite(endSeconds) || endSeconds <= 0) {
    violations.push(
      editRangeViolation('repaintEndSeconds', endSeconds, 0, sourceDurationSeconds),
    );
  }
  if (violations.length > 0) return { kind: 'invalid', violations };

  // Requirement 7.4, judged on what was asked rather than on what would survive
  // clamping.
  if (startSeconds >= endSeconds) {
    return {
      kind: 'invalid',
      violations: [
        editOrderingViolation(
          'repaintStartSeconds',
          { startSeconds, endSeconds },
          'repaintStartSeconds',
          'repaintEndSeconds',
        ),
      ],
    };
  }

  // A start already at or past the end of the audio leaves nothing to repaint, and
  // unlike 7.5 there is no shorter interval that still means what was asked.
  if (startSeconds >= sourceDurationSeconds) {
    return {
      kind: 'invalid',
      violations: [
        editRangeViolation('repaintStartSeconds', startSeconds, 0, sourceDurationSeconds),
      ],
    };
  }

  // Requirement 7.5.
  if (endSeconds > sourceDurationSeconds) {
    return {
      kind: 'resolved',
      range: { startSeconds, endSeconds: sourceDurationSeconds },
      adjustment: {
        field: 'repaintEndSeconds',
        requested: endSeconds,
        applied: sourceDurationSeconds,
        reason: 'clamped_to_source_length',
      },
    };
  }

  return { kind: 'resolved', range: { startSeconds, endSeconds } };
}
