/**
 * Property 19 and the voice invariants, over generated sequences.
 *
 * **Validates: Requirements 32.5, 32.6, 32.8, 32.21, 32.22 · Property 19**
 *
 * ### Why these are property tests and not examples
 *
 * Requirement 32.5 is written as an invariant — 0 ≤ voices ≤ 8 — and an invariant is a claim about
 * *every* reachable state. An example test picks one path to a full layer; a generated sequence
 * picks thousands, including the ones nobody would think to write: eight loops and then a
 * one-shot, a repeat inside the interval window of a cue that was just evicted, a loop restarted
 * in the same millisecond it was stopped.
 *
 * Property 19 is the same shape from design §10: *for any* sounding loop, a repeat leaves the
 * count alone and returns the same handle. The generator therefore builds sequences over the real
 * 78 cues rather than over two hand-picked ones, so a rule that happened to hold for the first
 * loop cue in the table is not what is being checked.
 *
 * The clock is part of the generated input. A property test that used a real clock would have its
 * 50 ms window depend on how fast the machine ran the loop, and the interval rule would be
 * checked or not depending on load.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LOOP_CUES, SEMANTIC_CUE_NAMES, cueDefinition, type SemanticCue } from '../../src/sound/cues';
import {
  MAX_VOICES,
  MIN_CUE_INTERVAL_MS,
  decidePlay,
  evictionCandidate,
  initialPolicyState,
  soundingLoop,
  voiceInvariantHolds,
  type PolicyState,
} from '../../src/sound/policy';

const RUNS = 200;

function unlocked(): PolicyState {
  return { ...initialPolicyState(true), unlocked: true };
}

function handleFor(cue: SemanticCue, sequence: number): string {
  return `${cue}#${String(sequence)}`;
}

/** One step of a generated sequence: a cue and how far the clock moved before it. */
interface Step {
  readonly cue: SemanticCue;
  readonly advanceMs: number;
}

const stepArbitrary = fc.record({
  cue: fc.constantFrom(...SEMANTIC_CUE_NAMES),
  // Spanning the 50 ms boundary in both directions, so the interval rule is exercised rather
  // than always satisfied or always violated.
  advanceMs: fc.integer({ min: 0, max: 120 }),
});

function run(steps: readonly Step[]): { state: PolicyState; nowMs: number } {
  let state = unlocked();
  let nowMs = 0;
  for (const step of steps) {
    nowMs += step.advanceMs;
    state = decidePlay(state, step.cue, nowMs, handleFor).state;
  }
  return { state, nowMs };
}

describe('Property 19 — 루프 재요청 멱등 (Req 32.6)', () => {
  it('a repeat of a sounding loop returns the same handle and adds no voice', () => {
    fc.assert(
      fc.property(
        fc.array(stepArbitrary, { maxLength: 30 }),
        fc.constantFrom(...LOOP_CUES),
        fc.integer({ min: 0, max: 5_000 }),
        (steps, loopCue, gapMs) => {
          const { state: reached, nowMs } = run(steps);

          // Start the loop, whatever the sequence left behind.
          const first = decidePlay(reached, loopCue, nowMs + 1_000, handleFor);
          // The sequence may have filled the layer with loops, in which case the loop could not
          // start; the property is about a loop that *is* sounding.
          fc.pre(first.result.played);
          const started = first.state;
          const handle = first.result.handle;

          // The repeat, at an arbitrary later moment — including inside the 50 ms window, where a
          // rule ordered the other way round would answer `min_interval` instead.
          const repeat = decidePlay(started, loopCue, nowMs + 1_000 + gapMs, handleFor);

          expect(repeat.result.played).toBe(true);
          expect(repeat.result.handle).toBe(handle);
          expect(repeat.state.voices.length).toBe(started.voices.length);
          // The instance itself is untouched: same start time, so the playhead keeps running.
          const before = soundingLoop(started.voices, loopCue);
          const after = soundingLoop(repeat.state.voices, loopCue);
          expect(after?.startedAtMs).toBe(before?.startedAtMs);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('starting a loop with no instance creates exactly one (Req 32.22)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LOOP_CUES), (loopCue) => {
        const decision = decidePlay(unlocked(), loopCue, 0, handleFor);
        expect(decision.kind).toBe('start');
        expect(decision.state.voices).toHaveLength(1);
        expect(decision.result.handle).toBe(decision.state.voices[0]?.handle);
        return true;
      }),
      { numRuns: LOOP_CUES.length },
    );
  });
});

describe('동시 재생 음성 불변식 (Req 32.5)', () => {
  it('never exceeds eight, over any sequence', () => {
    fc.assert(
      fc.property(fc.array(stepArbitrary, { maxLength: 200 }), (steps) => {
        let state = unlocked();
        let nowMs = 0;
        for (const step of steps) {
          nowMs += step.advanceMs;
          state = decidePlay(state, step.cue, nowMs, handleFor).state;
          // Asserted after *every* step, not only at the end: a sequence that briefly reached
          // nine and settled back to eight would pass an end-state check.
          expect(voiceInvariantHolds(state)).toBe(true);
        }
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('evicts the earliest one-shot and never a loop (Req 32.21)', () => {
    fc.assert(
      fc.property(fc.array(stepArbitrary, { minLength: 40, maxLength: 200 }), (steps) => {
        let state = unlocked();
        let nowMs = 0;
        for (const step of steps) {
          nowMs += step.advanceMs;
          const before = state.voices;
          const decision = decidePlay(state, step.cue, nowMs, handleFor);

          if (decision.kind === 'start' && decision.evict !== null) {
            expect(before.length).toBe(MAX_VOICES);
            expect(decision.evict.loop).toBe(false);
            // Nothing older among the one-shots.
            for (const voice of before) {
              if (voice.loop || voice.handle === decision.evict.handle) continue;
              expect(voice.startedAtMs).toBeGreaterThanOrEqual(decision.evict.startedAtMs);
            }
            // Every loop that was sounding still is.
            const loopsBefore = before.filter((voice) => voice.loop).map((voice) => voice.handle);
            const loopsAfter = decision.state.voices
              .filter((voice) => voice.loop)
              .map((voice) => voice.handle);
            for (const handle of loopsBefore) expect(loopsAfter).toContain(handle);
          }

          state = decision.state;
        }
        return true;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('최소 간격 (Req 32.8)', () => {
  it('suppresses a one-shot repeated inside 50 ms and plays it at exactly 50', () => {
    const oneShots = SEMANTIC_CUE_NAMES.filter((cue) => cueDefinition(cue).kind === 'oneshot');

    fc.assert(
      fc.property(
        fc.constantFrom(...oneShots),
        fc.integer({ min: 0, max: MIN_CUE_INTERVAL_MS - 1 }),
        (cue, gapMs) => {
          const first = decidePlay(unlocked(), cue, 1_000, handleFor);
          expect(first.result.played).toBe(true);

          const inside = decidePlay(first.state, cue, 1_000 + gapMs, handleFor);
          expect(inside.result.played).toBe(false);
          expect(inside.result.suppressionReason).toBe('min_interval');
          // A suppressed request must not move the window, or a caller clicking steadily every
          // 40 ms would be silenced forever rather than every other time.
          expect(inside.state.lastStartedAtMs[cue]).toBe(1_000);

          const at = decidePlay(first.state, cue, 1_000 + MIN_CUE_INTERVAL_MS, handleFor);
          expect(at.result.played).toBe(true);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('evictionCandidate', () => {
  it('is null when every voice is a loop, so no status sound is stolen for a click', () => {
    let state = unlocked();
    for (const [index, cue] of LOOP_CUES.slice(0, MAX_VOICES).entries()) {
      state = decidePlay(state, cue, index * 100, handleFor).state;
    }
    expect(state.voices).toHaveLength(MAX_VOICES);
    expect(evictionCandidate(state.voices)).toBeNull();

    // The ninth request is dropped rather than breaking the invariant or stopping a loop.
    const ninth = decidePlay(state, 'generation.succeeded', 10_000, handleFor);
    expect(ninth.result.played).toBe(false);
    expect(ninth.result.suppressionReason).toBeUndefined();
    expect(ninth.state.voices).toHaveLength(MAX_VOICES);
  });

  it('breaks a start-time tie by sequence, so eviction is deterministic', () => {
    // Two one-shots in the same millisecond. Without the tie-break, which one dies is whatever
    // the comparison happened to do.
    const first = decidePlay(unlocked(), 'playback.play', 500, handleFor);
    const second = decidePlay(first.state, 'playback.pause', 500, handleFor);
    const victim = evictionCandidate(second.state.voices);
    expect(victim?.cue).toBe('playback.play');
  });
});
