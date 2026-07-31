import { describe, expect, it } from 'vitest';

import { oneShotTailThresholds } from '../../../domain/quality/one-shot-tail-thresholds';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  changeThreshold,
} from '../../../domain/quality/threshold-set';
import { SFX_TAIL_WINDOW_MS } from '../../../domain/sfx/bounds';
import { evaluateSfxLoopSeam } from '../../../domain/sfx/loop-seam';
import { evaluateTailDecay, tailRatio } from '../../../domain/sfx/tail-decay';
import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import { measureLoopSync, measureTailDecaySync } from '../../../services/sound/in-process-measurement';
import { SFX_NO_TEMPO } from '../../../domain/sfx/loop-seam';
import {
  decayingOneShot,
  duplicatedToStereo,
  monoAudio,
  oneShotDecayExponent,
  seamlessSfxLoop,
  sustainedOneShot,
  withFadeOut,
} from '../../support/pcm-synthesis';

/**
 * One-shot tail decay and the SFX loop seam.
 *
 * **Validates: Requirements 22.14, 22.15, 34.6**
 *
 * The rules are tested against hand-written measurements *and* the measurement is tested
 * against synthesised audio, in the same file, because the two together are what Requirement
 * 22.15 asserts — a rule that is right about numbers nobody produces is not a check.
 */

const tailThresholds = oneShotTailThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const seamThresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);

function channel(tailPeakAbs: number, peakAbs: number) {
  return { tailPeakAbs, peakAbs };
}

function measurement(channels: readonly { tailPeakAbs: number; peakAbs: number }[]) {
  return { sampleRate: 48_000, durationMs: 2_000, channels };
}

describe('the tail rule over measurements (Requirement 22.15)', () => {
  it('admits a tail at exactly 5% of the peak (22.15 says 이하)', () => {
    expect(evaluateTailDecay(measurement([channel(0.05, 1.0)]), tailThresholds).satisfied).toBe(true);
  });

  it('refuses a tail marginally above the ceiling', () => {
    expect(evaluateTailDecay(measurement([channel(0.0501, 1.0)]), tailThresholds).satisfied).toBe(
      false,
    );
  });

  it('is a conjunction over channels: one bad channel fails the asset', () => {
    const verdict = evaluateTailDecay(
      measurement([channel(0.01, 1.0), channel(0.9, 1.0)]),
      tailThresholds,
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.worstTailRatio).toBeCloseTo(0.9, 10);
  });

  it('reports per-channel evidence, so a failure names the channel', () => {
    const verdict = evaluateTailDecay(
      measurement([channel(0.01, 1.0), channel(0.9, 1.0)]),
      tailThresholds,
    );

    expect(verdict.channels).toEqual([
      { channel: 0, tailRatio: 0.01 },
      { channel: 1, tailRatio: 0.9 },
    ]);
  });

  it('treats a silent channel as decayed rather than as NaN', () => {
    // A mono-in-stereo asset whose second channel is empty must not fail a rule it cannot break.
    expect(tailRatio(channel(0, 0))).toBe(0);
    expect(evaluateTailDecay(measurement([channel(0, 0)]), tailThresholds).satisfied).toBe(true);
  });

  it('treats an impossible channel — no peak but a loud tail — as failing', () => {
    expect(tailRatio(channel(0.5, 0))).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses an asset with no channels rather than passing it vacuously', () => {
    expect(evaluateTailDecay(measurement([]), tailThresholds).satisfied).toBe(false);
  });

  it('reads the ceiling from the threshold set and reports its version (Requirement 34.6)', () => {
    const changed = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'one_shot_tail_amplitude_ratio_max',
      0.2,
    );
    expect(changed.kind).toBe('applied');
    if (changed.kind !== 'applied') return;
    const loose = oneShotTailThresholds(changed.set);

    const subject = measurement([channel(0.15, 1.0)]);
    expect(evaluateTailDecay(subject, tailThresholds).satisfied).toBe(false);
    expect(evaluateTailDecay(subject, loose).satisfied).toBe(true);
    expect(evaluateTailDecay(subject, loose).thresholdSetVersion).toBe(changed.set.version);
  });
});

describe('the tail measurement over synthesised audio (Requirement 22.15)', () => {
  it('admits a decaying one-shot', () => {
    const audio = decayingOneShot({ durationMs: 1_500 });

    const verdict = evaluateTailDecay(
      measureTailDecaySync({ subject: { kind: 'pcm', audio } }),
      tailThresholds,
    );

    expect(verdict.satisfied).toBe(true);
  });

  it('refuses a one-shot still at full level when it stops', () => {
    const audio = sustainedOneShot({ durationMs: 1_500 });

    const verdict = evaluateTailDecay(
      measureTailDecaySync({ subject: { kind: 'pcm', audio } }),
      tailThresholds,
    );

    expect(verdict.satisfied).toBe(false);
    // A constant-level tone has a tail peak equal to its overall peak.
    expect(verdict.worstTailRatio).toBeCloseTo(1, 3);
  });

  it('measures the last 50 ms specifically, not the last few samples', () => {
    const sustained = sustainedOneShot({ durationMs: 2_000 }).channels[0];
    expect(sustained).toBeDefined();
    if (sustained === undefined) return;

    // A fade confined to the final 10 ms leaves the 50 ms window loud, so the rule still fires.
    const abrupt = monoAudio(withFadeOut(sustained, 10));
    expect(
      evaluateTailDecay(
        measureTailDecaySync({ subject: { kind: 'pcm', audio: abrupt } }),
        tailThresholds,
      ).satisfied,
    ).toBe(false);

    // A linear fade only reaches 5 % in its last 5 % of samples, so it has to be at least
    // twenty times the window before the last 50 ms sits under the ceiling. 1200 ms is.
    const gentle = monoAudio(withFadeOut(sustained, SFX_TAIL_WINDOW_MS * 24));
    expect(
      evaluateTailDecay(
        measureTailDecaySync({ subject: { kind: 'pcm', audio: gentle } }),
        tailThresholds,
      ).satisfied,
    ).toBe(true);
  });

  it('measures both channels of a stereo asset', () => {
    const audio = duplicatedToStereo(decayingOneShot({ durationMs: 800 }));
    const measured = measureTailDecaySync({ subject: { kind: 'pcm', audio } });

    expect(measured.channels).toHaveLength(2);
    expect(measured.channels[0]).toEqual(measured.channels[1]);
  });

  it('is deterministic: the same samples always measure identically', () => {
    const audio = () => decayingOneShot({ durationMs: 400 });

    expect(measureTailDecaySync({ subject: { kind: 'pcm', audio: audio() } })).toEqual(
      measureTailDecaySync({ subject: { kind: 'pcm', audio: audio() } }),
    );
  });

  it('the 0.1 s floor of 22.4 leaves 22.15 barely satisfiable', () => {
    // Requirement 22.4 permits a 0.1-second effect and Requirement 22.15 measures its last
    // 50 milliseconds — so *half* the asset is the tail window, and the whole second half has to
    // sit under 5 % of the peak. This is a real tension between two criteria, found by the
    // property test in `test/property/sfx-generation.test.ts`, and it is recorded here rather
    // than worked around: a decay gentle enough to sound natural at 2 seconds fails at 0.1.
    const shortest = 100;

    // A fourth-power decay — perfectly adequate at 2 s — is at (0.5)^4 = 6.25 % when the tail
    // window opens, so it misses the 5 % ceiling.
    expect(oneShotDecayExponent(2_000)).toBeLessThan(4);
    expect(0.5 ** 4).toBeGreaterThan(tailThresholds.tailAmplitudeRatioMax);

    // Satisfying 22.15 at the floor needs an envelope already near-silent at the halfway point.
    expect(oneShotDecayExponent(shortest)).toBeGreaterThan(5);
    const audio = decayingOneShot({ durationMs: shortest });
    expect(
      evaluateTailDecay(measureTailDecaySync({ subject: { kind: 'pcm', audio } }), tailThresholds)
        .satisfied,
    ).toBe(true);
  });

  it('clamps the window to a buffer shorter than 50 ms', () => {
    // Requirement 22.4 permits a 0.1 s effect; the window must not read before the buffer.
    const audio = decayingOneShot({ durationMs: 20 });
    const measured = measureTailDecaySync({ subject: { kind: 'pcm', audio } });

    expect(Number.isNaN(measured.channels[0]?.tailPeakAbs ?? Number.NaN)).toBe(false);
  });
});

describe('the SFX loop seam (Requirement 22.14)', () => {
  it('admits a seamless loop and applies only the RMS criterion', () => {
    const audio = seamlessSfxLoop({ durationMs: 1_000 });

    const verdict = evaluateSfxLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio },
        bpm: SFX_NO_TEMPO,
        timeSignature: SFX_NO_TEMPO,
      }),
      seamThresholds,
    );

    expect(verdict.unmet).toEqual([]);
    expect(verdict.satisfied).toBe(true);
  });

  it('never reports bar alignment, which a sound effect has no tempo for', () => {
    // The tempo is 0, so the bar arithmetic yields an unaligned result — and it must not
    // surface, because Requirement 22.14 imposes no such criterion.
    const audio = decayingOneShot({ durationMs: 700 });

    const verdict = evaluateSfxLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio },
        bpm: SFX_NO_TEMPO,
        timeSignature: SFX_NO_TEMPO,
      }),
      seamThresholds,
    );

    expect(verdict.unmet).not.toContain('bar_alignment');
    expect(verdict.barAlignment.aligned).toBe(false);
  });

  it('refuses a loop whose two ends differ in level by more than 1.0 dB', () => {
    // A decaying one-shot is the clearest case: its tail is far quieter than its head.
    const audio = decayingOneShot({ durationMs: 1_000 });

    const verdict = evaluateSfxLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio },
        bpm: SFX_NO_TEMPO,
        timeSignature: SFX_NO_TEMPO,
      }),
      seamThresholds,
    );

    expect(verdict.unmet).toEqual(['seam_rms_difference']);
  });

  it('does not report sample step or edge energy, which 22.14 does not impose', () => {
    // A loop with deep fades at both ends breaks 21.16 and would break 21.8 at the seam; under
    // Requirement 22.14 neither is grounds for rejection. Documented as an open question in
    // `domain/sfx/loop-seam.ts`.
    const base = seamlessSfxLoop({ durationMs: 1_200 }).channels[0];
    expect(base).toBeDefined();
    if (base === undefined) return;
    const audio = monoAudio(withFadeOut(base, 300));

    const verdict = evaluateSfxLoopSeam(
      measureLoopSync({
        subject: { kind: 'pcm', audio },
        bpm: SFX_NO_TEMPO,
        timeSignature: SFX_NO_TEMPO,
      }),
      seamThresholds,
    );

    expect(verdict.unmet).not.toContain('edge_energy');
    expect(verdict.unmet).not.toContain('seam_sample_step');
  });
});
