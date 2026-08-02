import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { durationMs as audioDurationMs, frameCount } from '../../domain/audio/pcm';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../domain/quality/threshold-set';
import {
  v2aDurationThresholds,
  v2aOnsetAlignmentThresholds,
} from '../../domain/quality/v2a-thresholds';
import { variantSeeds } from '../../domain/sfx/seed';
import {
  evaluateOnsetAlignment,
  isAlignmentSatisfied,
  nearestOnsetMs,
} from '../../domain/v2a/alignment';
import {
  V2A_CONFIDENCE_MAX,
  V2A_CONFIDENCE_MIN,
  V2A_DURATION_MS_MAX,
  V2A_DURATION_MS_MIN,
  V2A_FRAME_RATE_MAX,
  V2A_FRAME_RATE_MIN,
  V2A_SAMPLE_FRAME_RATE,
  V2A_SEGMENT_ADVANCE_MS,
  V2A_SEGMENT_MAX_MS,
  V2A_SEGMENT_OVERLAP_MS,
  V2A_VARIANT_COUNT_MAX,
  V2A_VARIANT_COUNT_MIN,
} from '../../domain/v2a/bounds';
import { evaluateOutputDuration } from '../../domain/v2a/duration';
import {
  isNonDecreasing,
  isWithinSource,
  outputFrameCount,
  planFrameSampling,
} from '../../domain/v2a/frame-sampling';
import { onsetTimesMs } from '../../domain/v2a/onset';
import {
  crossfadeJoin,
  hasStatedOverlaps,
  joinedDurationMs,
  lastSegmentExceedsOverlap,
  respectsSegmentCeiling,
  segmentPlan,
} from '../../domain/v2a/segmentation';
import { validateV2aUpload } from '../../domain/v2a/validation';
import {
  buildVisualEventTimeline,
  hasNormalisedConfidences,
  isAscendingByTime,
  type VisualEvent,
} from '../../domain/v2a/visual-event-timeline';
import { frames, monoAudio } from '../support/pcm-synthesis';
import { consentingUpload, createV2aHarness, TEST_UPLOAD_ID } from '../support/v2a-harness';
import { foleyAudio, validVideoMetadata } from '../support/v2a-synthesis';

/**
 * Foley generation, as invariants over generated inputs.
 *
 * **Validates: Requirements 23.2, 23.3, 23.6, 23.7, 23.8, 23.9, 23.14, 23.15, 23.16**
 *
 * Scope note. **Design §10's numbered Correctness Property list assigns no Property to task
 * 2.6**, and tasks.md §9.2's ownership table names none either — Property 22 is task 2.5's SFX
 * reproducibility and Property 23 is task 2.7's dialogue reproducibility, so Requirement 23.14's
 * *foley* reproducibility has no number of its own. Every block below is therefore an
 * **unnumbered** property test, deliberately: inventing a Property 25 would be a change to design
 * §10 that is not this task's to make, and renumbering an existing one is forbidden. Task 9.2's
 * coverage audit must not count any block here against a numbered Property. **Reported as a spec
 * gap**: 23.8's alignment rate, 23.9's length invariant and 23.14's reproducibility are all
 * quantified invariants of exactly the kind §10 numbers, and the two acceptance criteria of task
 * 2.6 are both quantitative.
 *
 * Nothing here reaches a network, a decoder or an engine. The simulated engine in
 * `test/support/v2a-harness.ts` is a pure function of its request, which is what makes the
 * reproducibility claim checkable rather than assumed.
 */

/** Design §10: at least 100 cases per property. */
const RUNS = { numRuns: 100 };

const ALIGNMENT = v2aOnsetAlignmentThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const DURATION = v2aDurationThresholds(INITIAL_QUALITY_THRESHOLD_SET);

/**
 * Sample rate for the property tests, below design §5.1's 48 kHz on purpose.
 *
 * The onset rule is stated in *milliseconds* — a 5 ms frame over a 50 ms lookback — so it is
 * rate-independent, and 16 kHz still gives 80 samples per analysis frame. What changes is cost: at
 * 48 kHz a hundred cases over clips of up to twenty seconds is tens of millions of synthesised
 * samples for evidence a third of them gives just as well.
 */
const RATE = 16_000;

/**
 * Minimum gap between synthesised impacts, milliseconds.
 *
 * A property of the **fixture**, not of Requirement 23.8. `foleyAudio` decays each impact with a
 * 40 ms time constant, so two impacts 50 ms apart leave the second rising only ~4 dB above the
 * first one's tail — under the 6.0 dB threshold. That is honest behaviour of a real detector on
 * real overlapping transients, not a defect, but a generator that produced such pairs would be
 * asserting something about the fixture's envelope rather than about the rule. 250 ms puts the
 * preceding tail ~50 dB down.
 */
const MIN_IMPACT_GAP_MS = 250;

/** Impact times ascending with a stateable gap, plus the clip length that holds them. */
const arbImpactClip = fc
  .array(fc.integer({ min: MIN_IMPACT_GAP_MS, max: 1_500 }), { minLength: 1, maxLength: 8 })
  .map((gaps) => {
    const times: number[] = [];
    let cursor = 0;
    for (const gap of gaps) {
      cursor += gap;
      times.push(cursor);
    }
    // Half a second of room after the last impact, so its decay is inside the clip.
    return { impactTimesMs: times, durationMs: cursor + 500 };
  });

/** A confidence at or above the floor, so the event counts towards 23.8's rate. */
const arbConfidentConfidence = fc.double({
  min: ALIGNMENT.visualEventConfidenceMin,
  max: V2A_CONFIDENCE_MAX,
  noNaN: true,
});

/** A confidence strictly below the floor, so 23.8 must ignore the event. */
const arbFaintConfidence = fc.double({
  min: V2A_CONFIDENCE_MIN,
  max: ALIGNMENT.visualEventConfidenceMin - 0.01,
  noNaN: true,
});

const arbClipDurationMs = fc.integer({ min: V2A_DURATION_MS_MIN, max: V2A_DURATION_MS_MAX });

describe('the onset alignment rate stays at or above 90 % (Requirement 23.8)', () => {
  /**
   * Task 2.6's first acceptance criterion — "온셋 정렬률 90% 이상 달성" — over the real detector.
   *
   * Stated on whole-clip audio rather than through the service so that the claim is about the
   * detection rule and nothing else; the service path is asserted separately below.
   */
  it('aligns every confident event when the audio has an impact at its time', () => {
    fc.assert(
      fc.property(
        arbImpactClip,
        fc.array(arbConfidentConfidence, { minLength: 1, maxLength: 8 }),
        (clip, confidences) => {
          const audio = foleyAudio({ ...clip, sampleRate: RATE });
          const events: VisualEvent[] = clip.impactTimesMs.map((timeMs, index) => ({
            timeMs,
            confidence: confidences[index % confidences.length] ?? 1,
            category: 'impact',
          }));

          const verdict = evaluateOnsetAlignment(
            {
              timeline: buildVisualEventTimeline(events, ALIGNMENT.visualEventConfidenceMin),
              onsetTimesMs: onsetTimesMs(audio, { riseDb: ALIGNMENT.onsetRiseDb }),
            },
            ALIGNMENT,
          );

          expect(verdict.kind).toBe('measured');
          if (verdict.kind !== 'measured') return;
          expect(verdict.rate).toBeGreaterThanOrEqual(ALIGNMENT.alignmentRateMin);
          expect(verdict.satisfied).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('ignores events below the confidence floor, whatever the audio does', () => {
    fc.assert(
      fc.property(
        arbImpactClip,
        fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 1, maxLength: 6 }),
        fc.array(arbFaintConfidence, { minLength: 1, maxLength: 6 }),
        (clip, faintTimes, faintConfidences) => {
          const audio = foleyAudio({ ...clip, sampleRate: RATE });
          const events: VisualEvent[] = [
            ...clip.impactTimesMs.map((timeMs) => ({ timeMs, confidence: 1, category: 'impact' })),
            // Faint events placed anywhere, aligned or not: 23.8 must not count them.
            ...faintTimes.map((timeMs, index) => ({
              timeMs,
              confidence: faintConfidences[index % faintConfidences.length] ?? 0,
              category: 'noise',
            })),
          ];

          const verdict = evaluateOnsetAlignment(
            {
              timeline: buildVisualEventTimeline(events, ALIGNMENT.visualEventConfidenceMin),
              onsetTimesMs: onsetTimesMs(audio, { riseDb: ALIGNMENT.onsetRiseDb }),
            },
            ALIGNMENT,
          );

          expect(verdict.kind).toBe('measured');
          if (verdict.kind !== 'measured') return;
          expect(verdict.confidentEventCount).toBe(clip.impactTimesMs.length);
          expect(verdict.satisfied).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('is a ratio in [0, 1] that agrees with its own numerator and denominator', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ timeMs: fc.integer({ min: 0, max: 60_000 }), confidence: fc.double({ min: 0, max: 1, noNaN: true }) }),
          { maxLength: 30 },
        ),
        fc.array(fc.integer({ min: 0, max: 60_000 }), { maxLength: 30 }),
        (rawEvents, onsets) => {
          const verdict = evaluateOnsetAlignment(
            {
              timeline: buildVisualEventTimeline(
                rawEvents.map((event) => ({ ...event, category: 'x' })),
                ALIGNMENT.visualEventConfidenceMin,
              ),
              onsetTimesMs: onsets,
            },
            ALIGNMENT,
          );

          if (verdict.kind === 'no_confident_events') {
            // Requirement 23.16's case: no rate exists, and the check must not fail the asset.
            expect(isAlignmentSatisfied(verdict)).toBe(true);
            return;
          }
          expect(verdict.rate).toBeGreaterThanOrEqual(0);
          expect(verdict.rate).toBeLessThanOrEqual(1);
          expect(verdict.rate).toBe(verdict.alignedEventCount / verdict.confidentEventCount);
          expect(verdict.satisfied).toBe(verdict.rate >= ALIGNMENT.alignmentRateMin);
          expect(verdict.events).toHaveLength(verdict.confidentEventCount);
        },
      ),
      RUNS,
    );
  });

  it('marks an event aligned exactly when some onset is within the tolerance', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60_000 }),
        fc.array(fc.integer({ min: 0, max: 60_000 }), { minLength: 1, maxLength: 20 }),
        (eventTimeMs, onsets) => {
          const sorted = [...onsets].sort((first, second) => first - second);
          const verdict = evaluateOnsetAlignment(
            {
              timeline: buildVisualEventTimeline(
                [{ timeMs: eventTimeMs, confidence: 1, category: 'x' }],
                ALIGNMENT.visualEventConfidenceMin,
              ),
              onsetTimesMs: sorted,
            },
            ALIGNMENT,
          );

          expect(verdict.kind).toBe('measured');
          if (verdict.kind !== 'measured') return;
          // The nearest onset decides, and it is the same one a linear scan would find.
          const nearest = nearestOnsetMs(eventTimeMs, sorted);
          const linear = sorted.reduce((best, onset) =>
            Math.abs(onset - eventTimeMs) < Math.abs(best - eventTimeMs) ? onset : best,
          );
          expect(nearest).toBe(linear);
          expect(verdict.events[0]?.aligned).toBe(
            Math.abs((nearest ?? 0) - eventTimeMs) <= ALIGNMENT.alignmentToleranceMs,
          );
        },
      ),
      RUNS,
    );
  });
});

describe('the output length stays within ±40 ms of the video (Requirement 23.9)', () => {
  /**
   * Task 2.6's second acceptance criterion — "산출 오디오 길이 ±40밀리초 이내".
   *
   * Established by the segmentation arithmetic rather than filtered for: the plan advances by
   * `8000 − 50` ms and the join consumes each overlap exactly once, so the joined length *equals*
   * the input length up to per-segment frame rounding. The property is what says that held.
   */
  it('joins any clip 23.3 permits back to its own length', () => {
    fc.assert(
      fc.property(arbClipDurationMs, (totalMs) => {
        const plan = segmentPlan(totalMs);
        const joined = crossfadeJoin(
          plan.segments.map((segment) =>
            monoAudio(new Float32Array(Math.max(1, frames(segment.durationMs, RATE))).fill(0.3), RATE),
          ),
          plan.overlapMs,
        );

        const verdict = evaluateOutputDuration(
          { inputDurationMs: totalMs, outputDurationMs: joined.durationMs },
          DURATION,
        );

        expect(verdict.satisfied).toBe(true);
        // Far tighter than the tolerance: the error is frame rounding, not drift.
        expect(Math.abs(verdict.errorMs)).toBeLessThanOrEqual(1000 / RATE);
        expect(audioDurationMs(joined.audio)).toBeCloseTo(joined.durationMs, 9);
      }),
      RUNS,
    );
  });

  it('predicts the joined length from the plan alone, before any audio exists', () => {
    fc.assert(
      fc.property(arbClipDurationMs, (totalMs) => {
        const plan = segmentPlan(totalMs);
        expect(joinedDurationMs(plan)).toBeCloseTo(totalMs, 6);
      }),
      RUNS,
    );
  });

  it('holds for an injected segment window too, so it is arithmetic and not a coincidence', () => {
    fc.assert(
      fc.property(
        arbClipDurationMs,
        fc.integer({ min: 200, max: 4_000 }),
        fc.integer({ min: 5, max: 100 }),
        (totalMs, segmentMaxMs, overlapMs) => {
          fc.pre(overlapMs < segmentMaxMs);
          const plan = segmentPlan(totalMs, { segmentMaxMs, overlapMs });
          expect(joinedDurationMs(plan)).toBeCloseTo(totalMs, 6);
        },
      ),
      RUNS,
    );
  });
});

describe('the segment plan (Requirement 23.7)', () => {
  it('never exceeds the engine window, always overlaps by exactly 50 ms, never ends mid-fade', () => {
    fc.assert(
      fc.property(arbClipDurationMs, (totalMs) => {
        const plan = segmentPlan(totalMs);

        expect(respectsSegmentCeiling(plan)).toBe(true);
        expect(hasStatedOverlaps(plan)).toBe(true);
        expect(lastSegmentExceedsOverlap(plan)).toBe(true);
        expect(plan.segments[0]?.startMs).toBe(0);
        expect(plan.segments.at(-1)?.endMs).toBe(totalMs);
        expect(plan.overlapMs).toBe(V2A_SEGMENT_OVERLAP_MS);
      }),
      RUNS,
    );
  });

  it('uses the smallest count that covers the clip, so no segment is generated for nothing', () => {
    fc.assert(
      fc.property(arbClipDurationMs, (totalMs) => {
        const count = segmentPlan(totalMs).segments.length;
        // The derived advance, checked against the two constants it is derived from so they
        // cannot drift apart from it.
        const advance = V2A_SEGMENT_ADVANCE_MS;
        expect(advance).toBe(V2A_SEGMENT_MAX_MS - V2A_SEGMENT_OVERLAP_MS);

        expect((count - 1) * advance + V2A_SEGMENT_MAX_MS).toBeGreaterThanOrEqual(totalMs);
        if (count > 1) {
          // One fewer segment would not reach the end of the clip.
          expect((count - 2) * advance + V2A_SEGMENT_MAX_MS).toBeLessThan(totalMs);
        }
      }),
      RUNS,
    );
  });

  it('covers the clip with no gap: each segment starts inside its predecessor', () => {
    fc.assert(
      fc.property(arbClipDurationMs, (totalMs) => {
        const plan = segmentPlan(totalMs);
        for (let index = 1; index < plan.segments.length; index += 1) {
          const previous = plan.segments[index - 1];
          const current = plan.segments[index];
          expect(current?.startMs).toBeLessThan(previous?.endMs ?? 0);
          expect(current?.startMs).toBeGreaterThan(previous?.startMs ?? -1);
        }
      }),
      RUNS,
    );
  });

  it('preserves the frame count identity when joining real buffers', () => {
    fc.assert(
      fc.property(arbClipDurationMs, (totalMs) => {
        const plan = segmentPlan(totalMs);
        const lengths = plan.segments.map((segment) =>
          Math.max(1, frames(segment.durationMs, RATE)),
        );
        const joined = crossfadeJoin(
          lengths.map((length) => monoAudio(new Float32Array(length).fill(0.2), RATE)),
          plan.overlapMs,
        );

        const summed = lengths.reduce((total, length) => total + length, 0);
        const consumed = joined.overlapFrames.reduce((total, count) => total + count, 0);
        expect(frameCount(joined.audio)).toBe(summed - consumed);
      }),
      RUNS,
    );
  });
});

describe('24 fps sampling (Requirement 23.6)', () => {
  const arbFrameRate = fc.double({
    min: V2A_FRAME_RATE_MIN,
    max: V2A_FRAME_RATE_MAX,
    noNaN: true,
  });

  it('produces one index per output frame at 24 fps, never reordered, never out of range', () => {
    fc.assert(
      fc.property(
        arbFrameRate,
        fc.integer({ min: V2A_DURATION_MS_MIN, max: V2A_SEGMENT_MAX_MS }),
        (sourceFrameRate, durationMs) => {
          const plan = planFrameSampling({
            sourceFrameRate,
            sourceFrameCount: Math.max(1, Math.round((durationMs * sourceFrameRate) / 1000)),
            durationMs,
          });

          expect(plan.targetFrameRate).toBe(V2A_SAMPLE_FRAME_RATE);
          expect(plan.sourceIndices).toHaveLength(outputFrameCount(durationMs));
          expect(isNonDecreasing(plan.sourceIndices)).toBe(true);
          expect(isWithinSource(plan)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('duplicates the preceding frame exactly when the source is slower than 24 fps', () => {
    fc.assert(
      fc.property(
        arbFrameRate,
        fc.integer({ min: 1_000, max: V2A_SEGMENT_MAX_MS }),
        (sourceFrameRate, durationMs) => {
          const plan = planFrameSampling({
            sourceFrameRate,
            // Generous, so the tail clamp cannot be mistaken for 23.6's duplication.
            sourceFrameCount: Math.ceil((durationMs * sourceFrameRate) / 1000) + 2,
            durationMs,
          });

          expect(plan.clampedCount).toBe(0);
          if (sourceFrameRate >= V2A_SAMPLE_FRAME_RATE) {
            expect(plan.duplicatedCount).toBe(0);
          } else {
            expect(plan.duplicatedCount).toBeGreaterThan(0);
          }
        },
      ),
      RUNS,
    );
  });
});

describe('the Visual_Event_Timeline (Requirements 23.15, 23.16)', () => {
  it('is always ascending with confidences inside 0.00–1.00, for any detector output', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            timeMs: fc.integer({ min: -1_000, max: 70_000 }),
            confidence: fc.double({ min: -2, max: 3, noNaN: true }),
            category: fc.string(),
          }),
          { maxLength: 40 },
        ),
        (raw) => {
          const built = buildVisualEventTimeline(raw, ALIGNMENT.visualEventConfidenceMin);

          expect(isAscendingByTime(built.events)).toBe(true);
          expect(hasNormalisedConfidences(built.events)).toBe(true);
          expect(built.events.every((event) => event.category.length > 0)).toBe(true);
          // Requirement 23.16: the status is derived from the same floor 23.8 uses.
          expect(built.status).toBe(
            built.confidentEventCount > 0 ? 'events_detected' : 'no_visual_events_detected',
          );
        },
      ),
      RUNS,
    );
  });

  it('is idempotent: rebuilding an already-built timeline changes nothing', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            timeMs: fc.integer({ min: 0, max: 60_000 }),
            confidence: fc.double({ min: 0, max: 1, noNaN: true }),
            category: fc.constantFrom('impact', 'footstep', 'door'),
          }),
          { maxLength: 20 },
        ),
        (raw) => {
          const once = buildVisualEventTimeline(raw, ALIGNMENT.visualEventConfidenceMin);
          const twice = buildVisualEventTimeline(once.events, ALIGNMENT.visualEventConfidenceMin);
          expect(twice).toEqual(once);
        },
      ),
      RUNS,
    );
  });
});

describe('upload validation (Requirements 23.2, 23.3, 23.4)', () => {
  it('accepts exactly the records inside every bound, and names each failure otherwise', () => {
    fc.assert(
      fc.property(
        fc.record({
          container: fc.constantFrom('mp4', 'mov', 'webm', 'mkv', 'avi', ''),
          videoStreamCount: fc.integer({ min: 0, max: 3 }),
          frameRate: fc.double({ min: 0, max: 200, noNaN: true }),
          widthPx: fc.integer({ min: 16, max: 4_096 }),
          heightPx: fc.integer({ min: 16, max: 4_096 }),
          durationMs: fc.integer({ min: 0, max: 120_000 }),
          fileSizeBytes: fc.integer({ min: 0, max: 400_000_000 }),
        }),
        (probe) => {
          const metadata = validVideoMetadata(probe);
          const result = validateV2aUpload(metadata);

          const compliant =
            ['mp4', 'mov', 'webm'].includes(probe.container) &&
            probe.videoStreamCount >= 1 &&
            probe.frameRate >= V2A_FRAME_RATE_MIN &&
            probe.frameRate <= V2A_FRAME_RATE_MAX &&
            Math.min(probe.widthPx, probe.heightPx) >= 128 &&
            probe.durationMs >= V2A_DURATION_MS_MIN &&
            probe.durationMs <= V2A_DURATION_MS_MAX &&
            probe.fileSizeBytes <= 200 * 1_000_000;

          expect(result.kind).toBe(compliant ? 'valid' : 'invalid');
          if (result.kind !== 'invalid') return;
          // Requirement 23.4: one constraint name per violation, and one violation per name.
          expect(result.constraints).toHaveLength(result.violations.length);
          expect(result.violations.map((violation) => violation.field)).toEqual([
            ...result.constraints,
          ]);
          expect(new Set(result.constraints).size).toBe(result.constraints.length);
        },
      ),
      RUNS,
    );
  });
});

describe('variant seeds (Requirements 23.1, 23.14)', () => {
  it('are distinct for every permitted count, with variant 0 equal to the base', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_147_483_647 }),
        fc.integer({ min: V2A_VARIANT_COUNT_MIN, max: V2A_VARIANT_COUNT_MAX }),
        (baseSeed, count) => {
          const seeds = variantSeeds(baseSeed, count);

          expect(seeds).toHaveLength(count);
          expect(seeds[0]).toBe(baseSeed);
          expect(new Set(seeds).size).toBe(count);
        },
      ),
      RUNS,
    );
  });
});

describe('the whole service path (Requirements 23.9, 23.14, 23.15)', () => {
  /**
   * The clip lengths this block generates.
   *
   * Capped at three segments rather than 23.3's eight, because a hundred cases of eight segments
   * of synthesised audio joined and analysed twice over is minutes of test time for evidence three
   * segments give just as well — the join is the same arithmetic at every seam, and the
   * segment-count edge cases are covered by the pure blocks above at the full 60-second range.
   */
  const arbServiceDurationMs = fc.integer({ min: V2A_DURATION_MS_MIN, max: 20_000 });

  const joinedBytes = (harness: ReturnType<typeof createV2aHarness>): Buffer => {
    const samples = harness.preview.requests[0]?.audio.channels[0] ?? new Float32Array(0);
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  };

  it('keeps 23.9 satisfied and the timeline ascending for any clip it accepts', async () => {
    await fc.assert(
      fc.asyncProperty(arbServiceDurationMs, async (durationMs) => {
        const harness = createV2aHarness({ sampleRate: RATE });
        harness.setMetadata(validVideoMetadata({ durationMs }));
        // Events well inside the clip, spaced past the fixture's decay.
        const events = [500, 1_200].filter((timeMs) => timeMs < durationMs - 400);
        harness.segments.setEvents(events.map((timeMs) => ({ timeMs, confidence: 0.9, category: 'impact' })));

        const outcome = await harness.service.generate({
          accountId: 'user-1',
          request: { uploadId: TEST_UPLOAD_ID },
          upload: consentingUpload(),
        });

        expect(outcome.kind).toBe('produced');
        if (outcome.kind !== 'produced') return;
        const variant = outcome.variants[0];
        expect(variant?.duration.satisfied).toBe(true);
        expect(Math.abs(variant?.duration.errorMs ?? Infinity)).toBeLessThanOrEqual(
          DURATION.outputDurationToleranceMs,
        );
        expect(isAscendingByTime(variant?.metadata.timeline.events ?? [])).toBe(true);
        expect(variant?.metadata.inputVideoDurationMs).toBe(durationMs);
      }),
      RUNS,
    );
  });

  it('reproduces sample-identical audio for the same seed, video and prompt (23.14)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2_147_483_647 }),
        fc.constantFrom(null, 'footsteps', 'glass breaking'),
        fc.integer({ min: V2A_DURATION_MS_MIN, max: 9_000 }),
        async (seed, prompt, durationMs) => {
          const run = async (): Promise<Buffer> => {
            const harness = createV2aHarness({ sampleRate: RATE });
            harness.setMetadata(validVideoMetadata({ durationMs }));
            harness.segments.setEvents([{ timeMs: 400, confidence: 0.9, category: 'impact' }]);
            const outcome = await harness.service.generate({
              accountId: 'user-1',
              request: {
                uploadId: TEST_UPLOAD_ID,
                seed,
                ...(prompt === null ? {} : { prompt }),
              },
              upload: consentingUpload(),
            });
            expect(outcome.kind).toBe('produced');
            return joinedBytes(harness);
          };

          expect((await run()).equals(await run())).toBe(true);
        },
      ),
      RUNS,
    );
  });
});
