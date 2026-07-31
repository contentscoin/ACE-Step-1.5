import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CROSSFADE_OVERLAP_MS, crossfadeJoin } from '../../domain/audio/crossfade';
import { durationMs as audioDurationMs, frameCount } from '../../domain/audio/pcm';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../domain/quality/threshold-set';
import {
  dialogueTailSilenceThresholds,
  voiceConversionThresholds,
} from '../../domain/quality/speech-thresholds';
import { SFX_SEED_MAX, SFX_SEED_MIN } from '../../domain/sfx/bounds';
import { variantSeeds } from '../../domain/sfx/seed';
import {
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  SPEAKING_RATE_MAX,
  SPEAKING_RATE_MIN,
  SPLIT_THRESHOLD_MAX,
  SPLIT_THRESHOLD_MIN,
} from '../../domain/speech/bounds';
import {
  dialogueTimingOf,
  gapsOf,
  isValidDialogueTiming,
  layoutDurationMs,
  layoutOf,
  retimeAfterResynthesis,
  type DialogueLayout,
} from '../../domain/speech/line-timing';
import { scriptLines } from '../../domain/speech/lines';
import { resolveParalinguisticTags } from '../../domain/speech/paralinguistic';
import {
  cutsAtPermittedPositions,
  isContiguousInOrder,
  joinChunks,
  respectsSentenceCount,
  splitScript,
} from '../../domain/speech/script-split';
import {
  adjustTailSilence,
  evaluateTailSilence,
  measureTailSilence,
} from '../../domain/speech/tail-silence';
import { evaluateConversionLength } from '../../domain/voice/conversion';
import {
  normaliseTranscriptionLines,
  isValidTranscription,
} from '../../domain/transcription/result';
import { frames, monoAudio, sine } from '../support/pcm-synthesis';
import { createSpeechHarness, dialogueRequest, TEST_OWNER_ID } from '../support/speech-harness';

/**
 * Dialogue generation, as invariants over generated inputs.
 *
 * **Validates: Requirements 25.11, 25.12, 25.13, 25.14, 25.16, 25.17, 25.18, 25.19, 25.20, 26.25,
 * 27.6, 27.7, 27.8**
 *
 * ### Numbered Property in this file
 *
 * Exactly one, and it is owned by task 2.7 per `tasks.md` §9.2's ownership table:
 *
 * > **Feature: ai-music-generation-service, Property 23: 대사 생성 재현성** — *For any* 동일한
 * > 시드·스크립트·Voice_Profile·엔진·발화 속도·음높이 조정 값 조합에 대해, 재요청 시 이전 산출물과
 * > 샘플 단위로 동일한 오디오가 산출된다.
 * >
 * > **Validates: Requirements 25.18**
 *
 * ### Everything else here is deliberately *unnumbered*
 *
 * Design §10 numbers Properties 1–24 and assigns task 2.7 only Property 23. The other blocks below
 * — the script-split round trip, the chunk-count bound, prefix invariance under re-synthesis, the
 * timing invariants, the tail-silence window, the conversion length invariant and the transcription
 * invariants — are quantified invariants of exactly the kind §10 numbers, but **inventing a
 * Property 25 would be a change to design §10 that is not this task's to make**, and renumbering an
 * existing one is forbidden. They are therefore ordinary property tests, labelled as unnumbered so
 * task 9.2's coverage audit does not count any of them against a numbered Property.
 *
 * **Reported as a spec gap**: Requirements 25.12, 25.13, 25.17 and 25.20 are all written as
 * 불변식 and both of task 2.7's acceptance criteria are invariants, yet §10 numbers none of them.
 *
 * Nothing here reaches a network or a speech model. The simulated engines in
 * `test/support/deterministic-tts-transport.ts` are pure functions of their wire payloads, which is
 * what makes Property 23 checkable rather than assumed.
 */

/** Design §10: at least 100 cases per property. */
const RUNS = { numRuns: 100 };

const TAIL = dialogueTailSilenceThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const LENGTH = voiceConversionThresholds(INITIAL_QUALITY_THRESHOLD_SET);

/**
 * Sample rate for the property tests, below design §5.1's 48 kHz on purpose.
 *
 * Every rule under test is stated in *milliseconds* — the 50 ms cross-fade, the 50–200 ms tail
 * window, the ±100 ms conversion tolerance — so all of them are rate-independent. What changes is
 * cost: at 48 kHz a hundred cases over multi-second utterances is tens of millions of synthesised
 * samples for evidence a third of them gives just as well.
 */
const RATE = 16_000;

/* --------------------------------------------------------------- generators */

/**
 * A script built from sentences and line breaks.
 *
 * Deliberately *not* arbitrary text: the generator has to produce scripts with the boundaries
 * Requirement 25.11 legislates about, or the split would never be exercised. Arbitrary text is
 * covered separately by `arbAnyScript`, which is what tests totality.
 */
const arbStructuredScript = fc
  .array(
    fc.tuple(
      fc.stringMatching(/^[A-Za-z가-힣 ]{1,40}$/u),
      fc.constantFrom('.', '?', '!', '。'),
      fc.constantFrom('', ' ', '\n', '\n\n'),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((parts) => parts.map(([body, terminator, separator]) => `${body}${terminator}${separator}`).join(''))
  .filter((script) => script.trim().length > 0);

/** Anything at all, so totality is a claim about every string rather than about nice ones. */
const arbAnyScript = fc.string({ maxLength: 300 });

const arbThreshold = fc.integer({ min: SPLIT_THRESHOLD_MIN, max: SPLIT_THRESHOLD_MAX });

/** A layout of 1–8 lines with plausible per-line durations and a 50 ms seam. */
const arbLayout: fc.Arbitrary<DialogueLayout> = fc
  .array(fc.integer({ min: 60, max: 4_000 }), { minLength: 1, maxLength: 8 })
  .map((durations) => ({
    segments: durations.map((durationMs, lineIndex) => ({
      lineIndex,
      text: `line ${String(lineIndex)}`,
      durationMs,
    })),
    overlapsMs: durations.slice(1).map(() => CROSSFADE_OVERLAP_MS),
  }));

const arbSeed = fc.integer({ min: SFX_SEED_MIN, max: SFX_SEED_MAX });

/* ============================================================================
 * Property 23 — the one numbered Property task 2.7 owns
 * ==========================================================================*/

describe('Property 23: 대사 생성 재현성 (Requirement 25.18)', () => {
  /**
   * Feature: ai-music-generation-service, Property 23: 대사 생성 재현성 — for any identical
   * combination of seed, script, Voice_Profile, engine, speaking rate and pitch adjustment,
   * re-requesting produces audio identical to the previous output sample for sample.
   *
   * **Validates: Requirements 25.18**
   *
   * The key is the six things 25.18 names and no others, which is why the split threshold is
   * generated too: two requests differing *only* in it must still agree, and they do because the
   * synthesis unit is the line rather than the chunk (see `services/speech/speech-service.ts`).
   */
  it('produces sample-identical audio for the same seed, script, profile, engine, rate and pitch', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSeed,
        fc.constantFrom('One line.', 'One.\nTwo.', 'A.\nB.\nC.\nD.'),
        fc.constantFrom('tts-engine-a', 'tts-engine-b'),
        fc.double({ min: SPEAKING_RATE_MIN, max: SPEAKING_RATE_MAX, noNaN: true }),
        fc.integer({ min: PITCH_SEMITONES_MIN, max: PITCH_SEMITONES_MAX }),
        arbThreshold,
        async (seed, script, engineId, speakingRate, pitchSemitones, splitThresholdChars) => {
          const run = async (threshold: number): Promise<Buffer> => {
            const harness = createSpeechHarness({ sampleRate: RATE });
            const profile = await harness.createClonedProfile();
            const outcome = await harness.speech.generate({
              accountId: TEST_OWNER_ID,
              request: dialogueRequest(profile.voiceProfileId, {
                script,
                engineId,
                languageCode: 'ko',
                seed,
                speakingRate,
                pitchSemitones,
                splitThresholdChars: threshold,
              }),
            });
            if (outcome.kind !== 'produced') throw new Error('expected a produced dialogue');
            const samples = outcome.audio.channels[0] ?? new Float32Array(0);
            return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
          };

          const first = await run(splitThresholdChars);
          // The same request again, and once more with a different split threshold — which 25.18's
          // key omits, so the audio must not depend on it.
          expect(first.equals(await run(splitThresholdChars))).toBe(true);
          expect(first.equals(await run(SPLIT_THRESHOLD_MIN))).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('derives distinct per-line seeds from one base, so the lines differ', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 1, max: 20 }), (baseSeed, lineCount) => {
        const seeds = variantSeeds(baseSeed, lineCount);

        expect(seeds).toHaveLength(lineCount);
        expect(seeds[0]).toBe(baseSeed);
        expect(new Set(seeds).size).toBe(lineCount);
      }),
      RUNS,
    );
  });
});

/* ============================================================================
 * Unnumbered properties — see the module comment
 * ==========================================================================*/

describe('the script split is total and order-preserving (Requirements 25.11, 25.12) [unnumbered]', () => {
  it('round-trips any script at any threshold, which is the order invariant of 25.12', () => {
    fc.assert(
      fc.property(arbAnyScript, arbThreshold, (script, thresholdChars) => {
        const split = splitScript(script, { thresholdChars });

        expect(joinChunks(split)).toBe(script);
        expect(isContiguousInOrder(split)).toBe(true);
      }),
      RUNS,
    );
  });

  it('round-trips a structured script at every threshold, including the smallest', () => {
    fc.assert(
      fc.property(
        arbStructuredScript,
        fc.integer({ min: 1, max: 200 }),
        (script, thresholdChars) => {
          const split = splitScript(script, { thresholdChars });

          expect(joinChunks(split)).toBe(script);
          expect(cutsAtPermittedPositions(split)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('never cuts anywhere but after a newline or a terminator (25.11)', () => {
    fc.assert(
      fc.property(arbAnyScript, fc.integer({ min: 1, max: 100 }), (script, thresholdChars) => {
        expect(cutsAtPermittedPositions(splitScript(script, { thresholdChars }))).toBe(true);
      }),
      RUNS,
    );
  });

  it('keeps the chunk count at or below the sentence count (25.13), for any script', () => {
    fc.assert(
      fc.property(arbAnyScript, fc.integer({ min: 1, max: 100 }), (script, thresholdChars) => {
        expect(respectsSentenceCount(splitScript(script, { thresholdChars }))).toBe(true);
      }),
      RUNS,
    );
  });

  /**
   * The premise the count argument rests on, stated where it is actually true.
   *
   * `fc.pre` rather than an unconditional claim, and the precondition is not a convenience — it is
   * exactly what Requirement 25.4 guarantees. 25.4 bounds the script at one character *measured
   * trimmed* (see `domain/speech/validation.ts`), so a script of nothing but whitespace is refused
   * before the splitter is ever called. A property test found the boundary: an all-whitespace script
   * splits into one whitespace-only chunk, which is the only answer that keeps the round trip of
   * 25.12 intact — returning no chunks would lose the characters. `test/unit/speech/script-split.test.ts`
   * pins that behaviour explicitly rather than leaving it merely excluded here.
   */
  it('gives every chunk some text, for any script Requirement 25.4 accepts', () => {
    fc.assert(
      fc.property(arbAnyScript, fc.integer({ min: 1, max: 100 }), (script, thresholdChars) => {
        fc.pre(script.trim().length > 0);
        for (const chunk of splitScript(script, { thresholdChars }).chunks) {
          expect(chunk.text.trim().length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  it('preserves the line order through split and splice (task 2.7 acceptance criterion)', () => {
    fc.assert(
      fc.property(arbStructuredScript, arbThreshold, (script, thresholdChars) => {
        const split = splitScript(script, { thresholdChars });
        // The split chunks reassembled, then split into lines, give the same lines as the original
        // — which is the "행 순서 보존" the acceptance criterion asks for.
        expect(scriptLines(joinChunks(split)).map((line) => line.text)).toEqual(
          scriptLines(script).map((line) => line.text),
        );
      }),
      RUNS,
    );
  });
});

describe('the timing invariants hold for any layout (Requirement 25.17) [unnumbered]', () => {
  it('is ascending, non-overlapping, positive and inside the total', () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const timing = dialogueTimingOf(layout);

        expect(isValidDialogueTiming(timing)).toBe(true);
        expect(timing.lines).toHaveLength(layout.segments.length);
        expect(timing.lines[0]?.startMs).toBe(0);
      }),
      RUNS,
    );
  });

  it('agrees with the layout arithmetic to within rounding', () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const timing = dialogueTimingOf(layout);

        expect(
          Math.abs(timing.totalDurationMs - layoutDurationMs(layout)),
        ).toBeLessThanOrEqual(layout.segments.length + 1);
      }),
      RUNS,
    );
  });

  it('round-trips through layoutOf', () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const recovered = layoutOf(dialogueTimingOf(layout), layout.overlapsMs);

        recovered.segments.forEach((segment, index) => {
          expect(
            Math.abs(segment.durationMs - (layout.segments[index]?.durationMs ?? 0)),
          ).toBeLessThanOrEqual(1);
        });
      }),
      RUNS,
    );
  });
});

describe('re-synthesis leaves the prefix untouched (Requirements 25.16, 25.20) [unnumbered]', () => {
  /**
   * Task 2.7's second acceptance criterion — "행 재생성 후 선행 행 타이밍 불변" — stated directly
   * over generated layouts and generated target indices.
   *
   * This is the invariant the design of `domain/speech/line-timing.ts` exists to make structural:
   * a line's start depends only on the durations before it, so the property is a consequence of the
   * arithmetic rather than of a shifting routine remembering not to touch the prefix.
   */
  it('changes no preceding line, for any layout, any target line and any new duration', () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.nat(),
        fc.integer({ min: 60, max: 8_000 }),
        (layout, rawIndex, newDurationMs) => {
          const lineIndex = rawIndex % layout.segments.length;
          const before = dialogueTimingOf(layout);
          const after = retimeAfterResynthesis(layout, lineIndex, newDurationMs);

          for (let position = 0; position < lineIndex; position += 1) {
            expect(after.timing.lines[position]).toEqual(before.lines[position]);
          }
          expect(isValidDialogueTiming(after.timing)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('moves every successor by exactly the delta and updates the total (25.16)', () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.nat(),
        fc.integer({ min: 60, max: 8_000 }),
        (layout, rawIndex, newDurationMs) => {
          const lineIndex = rawIndex % layout.segments.length;
          const before = dialogueTimingOf(layout);
          const after = retimeAfterResynthesis(layout, lineIndex, newDurationMs);
          if (!after.retimed) return;

          const delta = after.deltaMs;
          for (let position = lineIndex + 1; position < layout.segments.length; position += 1) {
            const wasStart = before.lines[position]?.startMs ?? 0;
            const wasEnd = before.lines[position]?.endMs ?? 0;
            // Within one millisecond of rounding, which is the resolution 25.14 stores at.
            expect(Math.abs((after.timing.lines[position]?.startMs ?? 0) - (wasStart + delta))).toBeLessThanOrEqual(1);
            expect(Math.abs((after.timing.lines[position]?.endMs ?? 0) - (wasEnd + delta))).toBeLessThanOrEqual(1);
          }
          expect(
            Math.abs(after.timing.totalDurationMs - (before.totalDurationMs + delta)),
          ).toBeLessThanOrEqual(1);
        },
      ),
      RUNS,
    );
  });

  it('preserves every inter-line gap (25.16)', () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.nat(),
        fc.integer({ min: 60, max: 8_000 }),
        (layout, rawIndex, newDurationMs) => {
          const lineIndex = rawIndex % layout.segments.length;
          const before = gapsOf(dialogueTimingOf(layout));
          const after = gapsOf(retimeAfterResynthesis(layout, lineIndex, newDurationMs).timing);

          expect(after).toEqual(before);
        },
      ),
      RUNS,
    );
  });
});

describe('the cross-fade join preserves length arithmetic (Requirement 25.11) [unnumbered]', () => {
  it('consumes exactly one overlap per seam, whatever the piece lengths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 20, max: 2_000 }), { minLength: 1, maxLength: 8 }),
        (durations) => {
          const pieces = durations.map((ms) =>
            monoAudio(new Float32Array(Math.max(1, frames(ms, RATE))).fill(0.3), RATE),
          );
          const joined = crossfadeJoin(pieces, CROSSFADE_OVERLAP_MS);

          const summed = pieces.reduce((total, piece) => total + frameCount(piece), 0);
          const consumed = joined.overlapFrames.reduce((total, count) => total + count, 0);
          expect(frameCount(joined.audio)).toBe(summed - consumed);
          expect(joined.overlapFrames).toHaveLength(pieces.length - 1);
          expect(audioDurationMs(joined.audio)).toBeCloseTo(joined.durationMs, 9);
        },
      ),
      RUNS,
    );
  });
});

describe('the tail silence lands in the window (Requirement 25.19) [unnumbered]', () => {
  it('adjusts any utterance into the 50\u2013200 ms window, and is then idempotent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 2_000 }),
        fc.integer({ min: 0, max: 1_500 }),
        (spokenMs, silentMs) => {
          const spokenFrames = Math.max(1, frames(spokenMs, RATE));
          const samples = new Float32Array(spokenFrames + frames(silentMs, RATE));
          samples.set(sine(220, spokenFrames, 0.6, RATE), 0);
          const audio = monoAudio(samples, RATE);

          const verdict = evaluateTailSilence(
            measureTailSilence(audio, TAIL.silenceFloorDbfs),
            TAIL,
          );
          const adjusted = adjustTailSilence(audio, verdict);
          const after = measureTailSilence(adjusted, TAIL.silenceFloorDbfs);

          // Within a frame of the window: the adjustment is in whole samples.
          const frameMs = 1000 / RATE;
          expect(after.trailingSilenceMs).toBeGreaterThanOrEqual(TAIL.tailSilenceMinMs - frameMs);
          expect(after.trailingSilenceMs).toBeLessThanOrEqual(TAIL.tailSilenceMaxMs + frameMs);

          // Idempotent: an adjusted asset is already satisfied, so nothing moves again.
          const second = evaluateTailSilence(after, TAIL);
          expect(frameCount(adjustTailSilence(adjusted, second))).toBe(frameCount(adjusted));
        },
      ),
      RUNS,
    );
  });
});

describe('the conversion length invariant (Requirement 26.25) [unnumbered]', () => {
  it('is satisfied exactly when the signed error is within the tolerance', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 600_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        (sourceDurationMs, errorMs) => {
          const verdict = evaluateConversionLength(
            { sourceDurationMs, outputDurationMs: sourceDurationMs + errorMs },
            LENGTH,
          );

          expect(verdict.errorMs).toBe(errorMs);
          expect(verdict.satisfied).toBe(Math.abs(errorMs) <= LENGTH.lengthToleranceMs);
          expect(verdict.qualityThresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
        },
      ),
      RUNS,
    );
  });
});

describe('transcription invariants (Requirements 27.6, 27.7, 27.8) [unnumbered]', () => {
  it('normalises any engine output into a compliant result', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            startMs: fc.integer({ min: -5_000, max: 60_000 }),
            endMs: fc.integer({ min: -5_000, max: 60_000 }),
            text: fc.string({ maxLength: 40 }),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: 500, max: 50_000 }),
        (rawLines, audioDurationMsValue) => {
          const lines = normaliseTranscriptionLines(rawLines, audioDurationMsValue);
          const result = {
            lines,
            language: { languageCode: 'en', confidence: 0.9, undetermined: false },
            audioDurationMs: audioDurationMsValue,
            tierId: 'fast',
            modelId: 'asr-fast-v1',
            reasonCode: null,
          } as const;

          expect(isValidTranscription(result)).toBe(true);
          for (const line of lines) {
            // 27.6, 27.7.
            expect(line.startMs).toBeGreaterThanOrEqual(0);
            expect(line.endMs).toBeLessThanOrEqual(audioDurationMsValue);
            expect(line.startMs).toBeLessThan(line.endMs);
          }
          // 27.8.
          for (let index = 1; index < lines.length; index += 1) {
            expect(lines[index]?.startMs).toBeGreaterThanOrEqual(lines[index - 1]?.startMs ?? 0);
          }
        },
      ),
      RUNS,
    );
  });

  it('is idempotent — normalising a normalised list changes nothing', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            startMs: fc.integer({ min: 0, max: 20_000 }),
            endMs: fc.integer({ min: 0, max: 20_000 }),
            text: fc.stringMatching(/^[a-z ]{1,20}$/u),
          }),
          { maxLength: 20 },
        ),
        (rawLines) => {
          const once = normaliseTranscriptionLines(rawLines, 20_000);
          expect(normaliseTranscriptionLines(once, 20_000)).toEqual(once);
        },
      ),
      RUNS,
    );
  });
});

describe('tag resolution is total (Requirements 25.8, 25.9) [unnumbered]', () => {
  it('never invents or loses non-tag characters', () => {
    fc.assert(
      fc.property(arbAnyScript, fc.boolean(), (script, supported) => {
        const resolved = resolveParalinguisticTags(script, supported);

        if (supported) {
          expect(resolved.script).toBe(script);
          expect(resolved.removedTags).toEqual([]);
          return;
        }
        // The stripped script is the original minus exactly the recognised tag markers.
        expect(resolved.script).toBe(script.replace(/\[(laugh|sigh|gasp)\]/giu, ''));
        expect(resolved.script.length).toBeLessThanOrEqual(script.length);
      }),
      RUNS,
    );
  });

  it('is idempotent for a non-supporting engine', () => {
    fc.assert(
      fc.property(arbAnyScript, (script) => {
        const once = resolveParalinguisticTags(script, false).script;
        expect(resolveParalinguisticTags(once, false).script).toBe(once);
      }),
      RUNS,
    );
  });
});

describe('the whole service path (Requirements 25.14, 25.17, 25.19) [unnumbered]', () => {
  it('produces a valid timing and a windowed tail for any structured script it accepts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[A-Za-z ]{1,30}$/u), { minLength: 1, maxLength: 6 }),
        async (bodies) => {
          const script = bodies.map((body) => `${body.trim() || 'line'}.`).join('\n');
          const harness = createSpeechHarness({ sampleRate: RATE });
          const profile = await harness.createClonedProfile();

          const outcome = await harness.speech.generate({
            accountId: TEST_OWNER_ID,
            request: dialogueRequest(profile.voiceProfileId, { script }),
          });

          expect(outcome.kind).toBe('produced');
          if (outcome.kind !== 'produced') return;

          expect(isValidDialogueTiming(outcome.timing)).toBe(true);
          // One stored line per non-blank script line, in order.
          expect(outcome.timing.lines.map((line) => line.text)).toEqual(
            scriptLines(script).map((line) => line.text),
          );
          // 25.13's bound, over the real service path.
          expect(outcome.chunkCount).toBeLessThanOrEqual(outcome.sentenceCount);
          // 25.19's window.
          expect(outcome.metadata.trailingSilenceMs).toBeGreaterThanOrEqual(
            TAIL.tailSilenceMinMs - 1,
          );
          expect(outcome.metadata.trailingSilenceMs).toBeLessThanOrEqual(TAIL.tailSilenceMaxMs + 1);
        },
      ),
      RUNS,
    );
  });

  it('keeps every preceding line\u2019s samples byte-identical through a re-synthesis (25.15)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.nat(),
        async (lineCount, rawIndex) => {
          const script = Array.from(
            { length: lineCount },
            (_value, index) => `Line number ${String(index)}.`,
          ).join('\n');
          const harness = createSpeechHarness({ sampleRate: RATE });
          const profile = await harness.createClonedProfile();

          const outcome = await harness.speech.generate({
            accountId: TEST_OWNER_ID,
            request: dialogueRequest(profile.voiceProfileId, { script }),
          });
          if (outcome.kind !== 'produced') throw new Error('expected a produced dialogue');

          const lineIndex = rawIndex % lineCount;
          const before = await harness.renditions.find(outcome.assetId);
          const beforeTiming = outcome.timing.lines;

          await harness.speech.resynthesiseLine({
            accountId: TEST_OWNER_ID,
            assetId: outcome.assetId,
            lineIndex,
          });
          const after = await harness.renditions.find(outcome.assetId);

          for (let position = 0; position < lineIndex; position += 1) {
            // The stored piece is the identical buffer — the strongest form of 25.15's claim.
            expect(after?.linePieces[position]).toBe(before?.linePieces[position]);
            expect(after?.timing.lines[position]).toEqual(beforeTiming[position]);
          }
          expect(isValidDialogueTiming(after?.timing ?? { lines: [], totalDurationMs: 0 })).toBe(
            true,
          );
        },
      ),
      // A whole generation plus a re-synthesis per case, so this block runs the design §10 minimum
      // rather than more.
      RUNS,
    );
  });
});
