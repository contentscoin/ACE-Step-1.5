import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { linearPositionAt, loopPositionAt, positionAt } from '../../../domain/playback/loop';

/**
 * Loop playback.
 *
 * **Validates: Requirement 12.9**
 *
 * Task 5.2's acceptance criterion is "루프 이음 연속 재생", and the seam is the only place a
 * loop can go wrong: at exactly `durationMs` the playhead is at the *start of the next pass*,
 * not at the end of this one. If both were true the boundary frame would play twice and the
 * listener would hear a stutter once per bar; if neither, a gap.
 */

const DURATION = 4_000;

describe('loopPositionAt (Requirement 12.9)', () => {
  it('is at the start before anything has elapsed', () => {
    expect(loopPositionAt(0, DURATION)).toEqual({ positionMs: 0, pass: 0 });
  });

  it('runs linearly through the first pass', () => {
    expect(loopPositionAt(1_500, DURATION)).toEqual({ positionMs: 1_500, pass: 0 });
    expect(loopPositionAt(3_999, DURATION)).toEqual({ positionMs: 3_999, pass: 0 });
  });

  it('treats the end as the start of the next pass, not the end of this one', () => {
    // The seam. Exclusive end: no position belongs to two passes.
    expect(loopPositionAt(DURATION, DURATION)).toEqual({ positionMs: 0, pass: 1 });
  });

  it('wraps repeatedly and counts the completed passes', () => {
    expect(loopPositionAt(DURATION + 250, DURATION)).toEqual({ positionMs: 250, pass: 1 });
    expect(loopPositionAt(DURATION * 3 + 1, DURATION)).toEqual({ positionMs: 1, pass: 3 });
  });

  it('clamps a negative elapsed time to the start', () => {
    expect(loopPositionAt(-500, DURATION)).toEqual({ positionMs: 0, pass: 0 });
  });

  it('has nowhere to go in a zero-length asset', () => {
    expect(loopPositionAt(9_000, 0)).toEqual({ positionMs: 0, pass: 0 });
  });
});

describe('linearPositionAt (a non-looping asset)', () => {
  it('stops at the end rather than wrapping', () => {
    expect(linearPositionAt(DURATION + 5_000, DURATION)).toEqual({
      positionMs: DURATION,
      pass: 0,
    });
  });

  it('never reports a pass', () => {
    for (const elapsed of [0, 100, DURATION, DURATION * 4]) {
      expect(linearPositionAt(elapsed, DURATION).pass).toBe(0);
    }
  });
});

describe('positionAt (the choice between them)', () => {
  it('wraps only when the asset loops', () => {
    expect(positionAt(DURATION + 100, DURATION, true)).toEqual({ positionMs: 100, pass: 1 });
    expect(positionAt(DURATION + 100, DURATION, false)).toEqual({
      positionMs: DURATION,
      pass: 0,
    });
  });
});

describe('loop invariants', () => {
  it('always lands inside the asset', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 1, max: 600_000 }),
        (elapsedMs, durationMs) => {
          const { positionMs, pass } = loopPositionAt(elapsedMs, durationMs);

          expect(positionMs).toBeGreaterThanOrEqual(0);
          expect(positionMs).toBeLessThan(durationMs);
          expect(pass).toBeGreaterThanOrEqual(0);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is continuous across the seam: one millisecond later is one millisecond further', () => {
    // What "이음 연속 재생" means arithmetically — no position is skipped and none repeats,
    // including at the wrap.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 2, max: 600_000 }),
        (elapsedMs, durationMs) => {
          const here = loopPositionAt(elapsedMs, durationMs);
          const next = loopPositionAt(elapsedMs + 1, durationMs);

          if (next.pass === here.pass) {
            expect(next.positionMs).toBe(here.positionMs + 1);
          } else {
            // A wrap, and only ever by one pass: the previous position was the last one.
            expect(next.pass).toBe(here.pass + 1);
            expect(next.positionMs).toBe(0);
            expect(here.positionMs).toBe(durationMs - 1);
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reconstructs the elapsed time from the pass and the position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 600_000 }),
        (elapsedMs, durationMs) => {
          const { positionMs, pass } = loopPositionAt(elapsedMs, durationMs);
          expect(pass * durationMs + positionMs).toBe(elapsedMs);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
