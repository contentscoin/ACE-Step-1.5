import { describe, expect, it } from 'vitest';

import {
  LOUDNESS_BLOCK_MS,
  SHORT_TERM_HOP_MS,
  SHORT_TERM_WINDOW_MS,
  integratedLoudnessLufs,
  maxShortTermLoudnessLufs,
  shortTermLoudnessesLufs,
} from '../../../domain/audio/loudness';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { packLoudnessThresholds } from '../../../domain/quality/sound-pack-thresholds';
import {
  PACK_LOUDNESS_HOP_MS,
  PACK_LOUDNESS_WINDOW_MS,
} from '../../../domain/sound-pack/bounds';
import {
  evaluatePackLoudness,
  judgeCueLoudness,
  measureAndJudgeCueLoudness,
} from '../../../domain/sound-pack/pack-loudness';
import {
  frames,
  monoAudio,
  scaled,
  sine,
  TEST_SAMPLE_RATE,
} from '../../support/pcm-synthesis';

/**
 * Requirement 24.7: the −25…−21 LUFS band, and the *maximum* short-term measurement it names.
 *
 * The distinction between 24.7's maximum and Requirement 30.24's gated integrated value is the
 * whole content of the clause and is invisible for a steady tone — so the tests that matter here
 * are the ones using a signal whose loudness varies over time.
 */

const thresholds = packLoudnessThresholds(INITIAL_QUALITY_THRESHOLD_SET);

/** A tone at `amplitude` for `durationMs`. */
function tone(durationMs: number, amplitude: number): ReturnType<typeof monoAudio> {
  return monoAudio(sine(400, frames(durationMs), amplitude));
}

/** A loud burst followed by a long quiet tail — the shape 24.7 and 30.24 disagree about. */
function burstThenTail(): ReturnType<typeof monoAudio> {
  const burst = sine(400, frames(400), 0.5);
  const tail = scaled(sine(400, frames(2_000), 0.5), 0.02);
  const samples = new Float32Array(burst.length + tail.length);
  samples.set(burst, 0);
  samples.set(tail, burst.length);
  return monoAudio(samples);
}

describe('Requirement 24.7\'s window is BS.1770-4\'s gating block', () => {
  it('is 400 ms at 100 ms intervals, in one place', () => {
    expect(SHORT_TERM_WINDOW_MS).toBe(400);
    expect(SHORT_TERM_HOP_MS).toBe(100);
    expect(SHORT_TERM_WINDOW_MS).toBe(LOUDNESS_BLOCK_MS);
    // `bounds.ts` and `loudness.ts` must not drift apart.
    expect(PACK_LOUDNESS_WINDOW_MS).toBe(SHORT_TERM_WINDOW_MS);
    expect(PACK_LOUDNESS_HOP_MS).toBe(SHORT_TERM_HOP_MS);
  });

  it('produces one window per 100 ms of a buffer longer than one window', () => {
    const values = shortTermLoudnessesLufs(tone(1_000, 0.5));

    // A 1 000 ms buffer holds windows starting at 0, 100, … 600 — seven of them.
    expect(values).toHaveLength(7);
    // Within a hundredth of a decibel rather than exactly equal: the K-weighting filter starts
    // from rest, so the first window carries its startup transient. That is the standard's
    // behaviour and not something to tune away.
    for (const value of values) {
      expect(Math.abs(value - (values[6] as number))).toBeLessThan(0.01);
    }
  });

  it('measures a buffer shorter than one window as a single window (24.7\'s own rule)', () => {
    // Most of the taxonomy is one-shots under 400 ms, so this is the normal path for a pack.
    expect(shortTermLoudnessesLufs(tone(150, 0.5))).toHaveLength(1);
    expect(maxShortTermLoudnessLufs(tone(150, 0.5))).toBeGreaterThan(-30);
  });

  it('returns -Infinity for silence rather than a floor', () => {
    expect(maxShortTermLoudnessLufs(monoAudio(new Float32Array(frames(500))))).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(shortTermLoudnessesLufs({ sampleRate: TEST_SAMPLE_RATE, channels: [] })).toEqual([]);
  });

  it('takes the maximum over windows, not their mean', () => {
    const audio = burstThenTail();
    const windows = shortTermLoudnessesLufs(audio);

    const maximum = maxShortTermLoudnessLufs(audio);
    const mean = windows.reduce((total, value) => total + value, 0) / windows.length;

    // The burst is 34 dB above the tail, so the loudest window sits far above the average of the
    // windows. This is the distinction that carries the whole clause, and a test using one steady
    // tone could not detect it: for a stationary signal the maximum and the mean agree.
    expect(maximum).toBeGreaterThan(mean + 10);

    // Worth stating what 24.7 and Requirement 30.24 do *not* differ by here: the integrated
    // measurement is **gated**, so it discards the quiet tail and lands near the burst as well.
    // The two clauses differ in the reduction, and the gate hides that for this signal.
    expect(integratedLoudnessLufs(audio)).toBeLessThan(maximum);
  });

  it('moves exactly with a uniform gain', () => {
    const quiet = tone(1_000, 0.5);
    const loud = monoAudio(scaled(quiet.channels[0] as Float32Array, 2));

    expect(maxShortTermLoudnessLufs(loud) - maxShortTermLoudnessLufs(quiet)).toBeCloseTo(
      20 * Math.log10(2),
      9,
    );
  });
});

describe('the band of Requirement 24.7 is inclusive at both ends', () => {
  it('admits exactly −25 and exactly −21, and nothing outside', () => {
    expect(judgeCueLoudness('hover', -25, thresholds).satisfied).toBe(true);
    expect(judgeCueLoudness('hover', -21, thresholds).satisfied).toBe(true);
    expect(judgeCueLoudness('hover', -23, thresholds).placement).toBe('within');

    expect(judgeCueLoudness('hover', -25.01, thresholds).placement).toBe('too_quiet');
    expect(judgeCueLoudness('hover', -20.99, thresholds).placement).toBe('too_loud');
  });

  it('reads its bounds from the threshold set and records its version', () => {
    const verdict = judgeCueLoudness('hover', -23, thresholds);

    expect(verdict.minLufs).toBe(-25);
    expect(verdict.maxLufs).toBe(-21);
    expect(verdict.qualityThresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('calls a silent cue too quiet rather than unmeasurable', () => {
    const verdict = judgeCueLoudness('hover', Number.NEGATIVE_INFINITY, thresholds);

    expect(verdict.placement).toBe('too_quiet');
    expect(verdict.satisfied).toBe(false);
  });

  it('calls a NaN measurement a failure rather than falling through to "within"', () => {
    expect(judgeCueLoudness('hover', Number.NaN, thresholds).satisfied).toBe(false);
  });

  it('measures and judges in one step for a caller holding samples', () => {
    // −23 LUFS by construction is not something a raw sine gives, so this asserts the plumbing
    // rather than the level: the verdict's measurement equals the module's own measurement.
    const audio = tone(500, 0.5);
    const verdict = measureAndJudgeCueLoudness('hover', audio, thresholds);

    expect(verdict.maxShortTermLufs).toBe(
      maxShortTermLoudnessLufs(audio, PACK_LOUDNESS_WINDOW_MS, PACK_LOUDNESS_HOP_MS),
    );
  });
});

describe('the pack-level invariant (Requirement 24.7)', () => {
  it('is satisfied only when every cue is inside the band', () => {
    const inside = ['hover', 'press', 'release'].map((name) =>
      judgeCueLoudness(name, -23, thresholds),
    );

    expect(evaluatePackLoudness(inside).satisfied).toBe(true);
    expect(evaluatePackLoudness(inside).outside).toEqual([]);
  });

  it('lists every offending cue rather than stopping at the first', () => {
    const cues = [
      judgeCueLoudness('hover', -30, thresholds),
      judgeCueLoudness('press', -23, thresholds),
      judgeCueLoudness('release', -10, thresholds),
    ];

    const verdict = evaluatePackLoudness(cues);

    expect(verdict.satisfied).toBe(false);
    expect(verdict.outside.map((cue) => cue.cueName)).toEqual(['hover', 'release']);
    expect(verdict.cues).toHaveLength(3);
  });

  it('is vacuously satisfied for an empty pack, which 24.2 catches instead', () => {
    // 24.7 quantifies over the cues a pack has; an empty pack has no cue outside the band. What
    // makes an empty pack wrong is Requirement 24.2's count, judged elsewhere.
    expect(evaluatePackLoudness([]).satisfied).toBe(true);
  });
});
