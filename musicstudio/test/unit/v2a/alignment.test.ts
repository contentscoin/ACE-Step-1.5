import { describe, expect, it } from 'vitest';

import { INITIAL_QUALITY_THRESHOLD_SET, changeThreshold } from '../../../domain/quality/threshold-set';
import {
  v2aDurationThresholds,
  v2aOnsetAlignmentThresholds,
  v2aPreviewSyncThresholds,
} from '../../../domain/quality/v2a-thresholds';
import {
  alignEvent,
  evaluateOnsetAlignment,
  isAlignmentSatisfied,
  nearestOnsetMs,
} from '../../../domain/v2a/alignment';
import { evaluateOutputDuration } from '../../../domain/v2a/duration';
import { evaluatePreviewSync } from '../../../domain/v2a/preview';
import {
  V2A_UNCATEGORISED_EVENT,
  buildVisualEventTimeline,
  confidentEvents,
  hasNormalisedConfidences,
  isAscendingByTime,
  normaliseConfidence,
  requiresAmbienceFallback,
} from '../../../domain/v2a/visual-event-timeline';
import { visualEvent } from '../../support/v2a-synthesis';

/**
 * The Visual_Event_Timeline and the three quality verdicts.
 *
 * **Validates: Requirements 23.8, 23.9, 23.12, 23.15, 23.16, 34.6**
 *
 * Stated over event times and onset times rather than over audio, deliberately: the *measurement*
 * of an onset is checked against synthesised buffers in `onset.test.ts`, and the *rule* is checked
 * here against generated time sets, so neither can hide a bug in the other.
 */

const ALIGNMENT = v2aOnsetAlignmentThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const DURATION = v2aDurationThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const SYNC = v2aPreviewSyncThresholds(INITIAL_QUALITY_THRESHOLD_SET);

function timeline(events: readonly ReturnType<typeof visualEvent>[]) {
  return buildVisualEventTimeline(events, ALIGNMENT.visualEventConfidenceMin);
}

describe('the timeline (Requirement 23.15)', () => {
  it('sorts ascending by time whatever order the detector reported', () => {
    const built = timeline([visualEvent(900), visualEvent(100), visualEvent(500)]);

    expect(built.events.map((event) => event.timeMs)).toEqual([100, 500, 900]);
    expect(isAscendingByTime(built.events)).toBe(true);
  });

  it('keeps the detectors own order among simultaneous events, which may be a ranking', () => {
    const built = timeline([
      visualEvent(200, { category: 'first' }),
      visualEvent(200, { category: 'second' }),
      visualEvent(200, { category: 'third' }),
    ]);

    expect(built.events.map((event) => event.category)).toEqual(['first', 'second', 'third']);
  });

  it('clamps confidence into 0.00–1.00 rather than rejecting a detector that overshoots', () => {
    const built = timeline([
      visualEvent(100, { confidence: 1.0000000002 }),
      visualEvent(200, { confidence: -0.3 }),
      visualEvent(300, { confidence: Number.NaN }),
    ]);

    expect(built.events.map((event) => event.confidence)).toEqual([1, 0, 0]);
    expect(hasNormalisedConfidences(built.events)).toBe(true);
    expect(normaliseConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('defaults a missing category rather than storing an empty name', () => {
    const built = timeline([visualEvent(100, { category: '   ' })]);

    expect(built.events[0]?.category).toBe(V2A_UNCATEGORISED_EVENT);
  });

  it('drops an event with no usable time, which could neither be sorted nor aligned', () => {
    const built = timeline([visualEvent(Number.NaN), visualEvent(100)]);

    expect(built.events.map((event) => event.timeMs)).toEqual([100]);
  });

  it('counts the confident events and exposes the floor they were counted against', () => {
    const built = timeline([
      visualEvent(100, { confidence: 0.5 }),
      visualEvent(200, { confidence: 0.49 }),
      visualEvent(300, { confidence: 0.9 }),
    ]);

    expect(built.confidenceMin).toBe(0.5);
    expect(built.confidentEventCount).toBe(2);
    expect(confidentEvents(built).map((event) => event.timeMs)).toEqual([100, 300]);
  });
});

describe('the detection status (Requirement 23.16)', () => {
  it('reports events detected when at least one clears the floor', () => {
    const built = timeline([visualEvent(100, { confidence: 0.5 })]);

    expect(built.status).toBe('events_detected');
    expect(requiresAmbienceFallback(built)).toBe(false);
  });

  it('treats an empty timeline and an all-low-confidence one as the same case', () => {
    const empty = timeline([]);
    const timid = timeline([visualEvent(100, { confidence: 0.4 }), visualEvent(200, { confidence: 0.1 })]);

    expect(empty.status).toBe('no_visual_events_detected');
    expect(timid.status).toBe('no_visual_events_detected');
    // Neither yields anything to align to, so 23.16 does not distinguish them by list length.
    expect(timid.events).toHaveLength(2);
    expect(requiresAmbienceFallback(timid)).toBe(true);
  });

  it('follows the configured floor, so 23.16 and 23.8 cannot disagree', () => {
    const raised = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'v2a_visual_event_confidence_min',
      0.95,
    );
    expect(raised.kind).toBe('applied');
    if (raised.kind !== 'applied') return;

    const built = buildVisualEventTimeline([visualEvent(100, { confidence: 0.9 })], 0.95);
    expect(built.status).toBe('no_visual_events_detected');
    expect(v2aOnsetAlignmentThresholds(raised.set).visualEventConfidenceMin).toBe(0.95);
  });
});

describe('the nearest onset', () => {
  it('finds the closest on either side', () => {
    expect(nearestOnsetMs(500, [100, 480, 900])).toBe(480);
    expect(nearestOnsetMs(500, [100, 520, 900])).toBe(520);
    expect(nearestOnsetMs(0, [100, 520])).toBe(100);
    expect(nearestOnsetMs(2_000, [100, 520])).toBe(520);
  });

  it('resolves a tie to the earlier onset, deterministically', () => {
    expect(nearestOnsetMs(500, [400, 600])).toBe(400);
  });

  it('answers null when the audio has no onsets at all', () => {
    expect(nearestOnsetMs(500, [])).toBeNull();
  });

  it('agrees with a linear scan over a large onset set', () => {
    const onsets = Array.from({ length: 500 }, (_unused, index) => index * 37);
    for (const time of [0, 19, 500, 4_321, 18_500, 40_000]) {
      const expected = onsets.reduce((best, onset) =>
        Math.abs(onset - time) < Math.abs(best - time) ? onset : best,
      );
      expect(nearestOnsetMs(time, onsets)).toBe(expected);
    }
  });
});

describe('the alignment rate (Requirement 23.8)', () => {
  it('counts an event as aligned when an onset sits inside its window', () => {
    const verdict = evaluateOnsetAlignment(
      { timeline: timeline([visualEvent(1_000)]), onsetTimesMs: [1_040] },
      ALIGNMENT,
    );

    expect(verdict.kind).toBe('measured');
    if (verdict.kind !== 'measured') return;
    expect(verdict.rate).toBe(1);
    expect(verdict.events[0]?.offsetMs).toBe(40);
    expect(verdict.satisfied).toBe(true);
  });

  it('includes the boundary, since 23.8 says the onset is inside a ±80 ms window', () => {
    const at80 = alignEvent(visualEvent(1_000), [1_080], ALIGNMENT.alignmentToleranceMs);
    const at81 = alignEvent(visualEvent(1_000), [1_081], ALIGNMENT.alignmentToleranceMs);
    const atMinus80 = alignEvent(visualEvent(1_000), [920], ALIGNMENT.alignmentToleranceMs);

    expect(at80.aligned).toBe(true);
    expect(atMinus80.aligned).toBe(true);
    expect(at81.aligned).toBe(false);
    expect(at81.offsetMs).toBe(81);
  });

  it('ignores events below the confidence floor in both numerator and denominator', () => {
    const verdict = evaluateOnsetAlignment(
      {
        timeline: timeline([
          visualEvent(1_000, { confidence: 0.9 }),
          // Unaligned, but too faint to count — so the rate stays 1.0.
          visualEvent(5_000, { confidence: 0.2 }),
        ]),
        onsetTimesMs: [1_000],
      },
      ALIGNMENT,
    );

    expect(verdict.kind).toBe('measured');
    if (verdict.kind !== 'measured') return;
    expect(verdict.confidentEventCount).toBe(1);
    expect(verdict.rate).toBe(1);
  });

  it('is satisfied at exactly 90 % and unsatisfied just below', () => {
    // Ten events, nine of them aligned.
    const events = Array.from({ length: 10 }, (_unused, index) => visualEvent(1_000 * (index + 1)));
    const nineAligned = events.slice(0, 9).map((event) => event.timeMs);

    const satisfied = evaluateOnsetAlignment(
      { timeline: timeline(events), onsetTimesMs: nineAligned },
      ALIGNMENT,
    );
    expect(satisfied.kind === 'measured' && satisfied.rate).toBe(0.9);
    expect(isAlignmentSatisfied(satisfied)).toBe(true);

    const missed = evaluateOnsetAlignment(
      { timeline: timeline(events), onsetTimesMs: nineAligned.slice(0, 8) },
      ALIGNMENT,
    );
    expect(missed.kind === 'measured' && missed.rate).toBe(0.8);
    expect(isAlignmentSatisfied(missed)).toBe(false);
  });

  it('reports every unaligned event with the distance it missed by', () => {
    const verdict = evaluateOnsetAlignment(
      {
        timeline: timeline([visualEvent(1_000), visualEvent(5_000)]),
        onsetTimesMs: [1_000],
      },
      ALIGNMENT,
    );

    expect(verdict.kind).toBe('measured');
    if (verdict.kind !== 'measured') return;
    const unaligned = verdict.events.filter((entry) => !entry.aligned);
    expect(unaligned).toHaveLength(1);
    // A timing problem and a missing sound are distinguishable by this number.
    expect(unaligned[0]?.offsetMs).toBe(-4_000);
  });

  it('marks every event unaligned, with no nearest onset, when the audio has none', () => {
    const verdict = evaluateOnsetAlignment(
      { timeline: timeline([visualEvent(1_000)]), onsetTimesMs: [] },
      ALIGNMENT,
    );

    expect(verdict.kind).toBe('measured');
    if (verdict.kind !== 'measured') return;
    expect(verdict.rate).toBe(0);
    expect(verdict.events[0]?.nearestOnsetMs).toBeNull();
    expect(verdict.events[0]?.offsetMs).toBeNull();
  });

  it('accepts onsets in any order and ignores unusable ones', () => {
    const verdict = evaluateOnsetAlignment(
      {
        timeline: timeline([visualEvent(1_000)]),
        onsetTimesMs: [Number.NaN, 9_000, 1_020, Number.POSITIVE_INFINITY],
      },
      ALIGNMENT,
    );

    expect(verdict.kind === 'measured' && verdict.rate).toBe(1);
  });

  it('records the threshold set version every verdict was taken against (34.6)', () => {
    const verdict = evaluateOnsetAlignment(
      { timeline: timeline([visualEvent(100)]), onsetTimesMs: [100] },
      ALIGNMENT,
    );

    expect(verdict.thresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
    expect(verdict.toleranceMs).toBe(80);
    expect(verdict.rateMin).toBe(0.9);
  });
});

describe('no confident event is unmeasurable, not a failure (Requirement 23.16)', () => {
  it('reports no rate at all rather than 0 or 1', () => {
    const verdict = evaluateOnsetAlignment(
      { timeline: timeline([visualEvent(100, { confidence: 0.2 })]), onsetTimesMs: [] },
      ALIGNMENT,
    );

    expect(verdict.kind).toBe('no_confident_events');
    expect(verdict.confidentEventCount).toBe(0);
    // 23.8's quantifier ranges over an empty set, and 23.16 explicitly permits this asset.
    expect(isAlignmentSatisfied(verdict)).toBe(true);
    expect('rate' in verdict).toBe(false);
  });
});

describe('the output length invariant (Requirement 23.9)', () => {
  it('accepts a length inside ±40 ms and reports the signed error', () => {
    const verdict = evaluateOutputDuration(
      { inputDurationMs: 4_000, outputDurationMs: 4_030 },
      DURATION,
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.errorMs).toBe(30);
    expect(verdict.toleranceMs).toBe(40);
    expect(verdict.thresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('includes both boundaries and refuses just outside them', () => {
    for (const output of [3_960, 4_040]) {
      expect(
        evaluateOutputDuration({ inputDurationMs: 4_000, outputDurationMs: output }, DURATION)
          .satisfied,
      ).toBe(true);
    }
    for (const output of [3_959, 4_041]) {
      expect(
        evaluateOutputDuration({ inputDurationMs: 4_000, outputDurationMs: output }, DURATION)
          .satisfied,
      ).toBe(false);
    }
  });

  it('fails an unmeasurable length rather than throwing, since the invariant claims evidence', () => {
    const verdict = evaluateOutputDuration(
      { inputDurationMs: 4_000, outputDurationMs: Number.NaN },
      DURATION,
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.errorMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the preview sync invariant (Requirement 23.12)', () => {
  it('accepts an offset inside ±20 ms and reports its sign', () => {
    const late = evaluatePreviewSync({ audioStartMs: 18, videoStartMs: 0 }, SYNC);
    const early = evaluatePreviewSync({ audioStartMs: 0, videoStartMs: 15 }, SYNC);

    expect(late.satisfied).toBe(true);
    expect(late.offsetMs).toBe(18);
    expect(early.satisfied).toBe(true);
    expect(early.offsetMs).toBe(-15);
    expect(late.toleranceMs).toBe(20);
  });

  it('includes both boundaries and refuses just outside them', () => {
    expect(evaluatePreviewSync({ audioStartMs: 20, videoStartMs: 0 }, SYNC).satisfied).toBe(true);
    expect(evaluatePreviewSync({ audioStartMs: 0, videoStartMs: 20 }, SYNC).satisfied).toBe(true);
    expect(evaluatePreviewSync({ audioStartMs: 21, videoStartMs: 0 }, SYNC).satisfied).toBe(false);
  });

  it('fails an unmeasurable offset rather than throwing', () => {
    expect(
      evaluatePreviewSync({ audioStartMs: Number.NaN, videoStartMs: 0 }, SYNC).satisfied,
    ).toBe(false);
  });
});
